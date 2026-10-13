/**
 * 実装セッションの依存待ち（#4321）の判断と表示。副作用を持たない純関数だけを置く。
 *
 * **`11.local`は「ローカルで対応中」の抑止フラグで、何を待っているのかは表せない。** 待ち理由・
 * 依存先・再開条件は`SessionDependencyWait`が持ち、このファイルが「条件が成り立ったか」と
 * 「画面にどう出すか」を決める。
 *
 * **条件を区別する。** 依存先のIssueがクローズされた・PRがdevelopへマージされた・実行環境（main）へ
 * 反映された・人による検証が済んだ、は別の条件で、前者が成立しても後者を満たしたとはみなさない。
 */

export const DEPENDENCY_WAIT_CONDITIONS = ["closed", "merged", "released", "verified"] as const;
export type DependencyWaitCondition = (typeof DEPENDENCY_WAIT_CONDITIONS)[number];

export const DEPENDENCY_WAIT_CONDITION_LABELS: Record<DependencyWaitCondition, string> = {
  closed: "依存先がクローズされる",
  merged: "依存先のPRがマージされる",
  released: "依存先の変更が本番（main）へ反映される",
  verified: "依存先の実環境での検証が済む（人の確認が必要）",
};

export type DependencyWaitStatus =
  | "WAITING"
  | "NEEDS_CONFIRM"
  | "RESUME_REQUESTED"
  | "RESUME_SENT"
  | "RESUMED"
  | "RESUME_FAILED"
  | "CANCELLED";

const STATUSES: readonly string[] = [
  "WAITING",
  "NEEDS_CONFIRM",
  "RESUME_REQUESTED",
  "RESUME_SENT",
  "RESUMED",
  "RESUME_FAILED",
  "CANCELLED",
];

export function parseDependencyWaitStatus(value: unknown): DependencyWaitStatus | null {
  return typeof value === "string" && STATUSES.includes(value) ? (value as DependencyWaitStatus) : null;
}

/** 待ちが続いている（`activeKey`を持つ）状態。RESUMED・CANCELLEDで終わる */
export function isActiveDependencyWaitStatus(status: DependencyWaitStatus): boolean {
  return status !== "RESUMED" && status !== "CANCELLED";
}

export type DependencyRef = {
  repository: string;
  number: number;
  kind: "issue" | "pr";
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REASON_MAX_LENGTH = 300;

export type DependencyWaitReport = {
  repositoryFullName: string;
  issueNumber: number;
  dependency: DependencyRef;
  conditions: DependencyWaitCondition[];
  reason: string;
};

function parseCondition(value: unknown): DependencyWaitCondition | null {
  return typeof value === "string" && (DEPENDENCY_WAIT_CONDITIONS as readonly string[]).includes(value)
    ? (value as DependencyWaitCondition)
    : null;
}

export function parseDependencyRef(value: unknown): DependencyRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.repository !== "string" || !REPOSITORY_PATTERN.test(v.repository)) return null;
  if (typeof v.number !== "number" || !Number.isInteger(v.number) || v.number < 1) return null;
  if (v.kind !== "issue" && v.kind !== "pr") return null;
  return { repository: v.repository, number: v.number, kind: v.kind };
}

/** 依存先・条件・理由を検証する。**どれかが欠ければ拒む**（推定で補わない） */
export function parseDependencyWaitInput(payload: unknown): {
  dependency: DependencyRef;
  conditions: DependencyWaitCondition[];
  reason: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const dependency = parseDependencyRef(p.dependency);
  if (!dependency) return null;
  if (!Array.isArray(p.conditions) || p.conditions.length === 0) return null;
  const conditions: DependencyWaitCondition[] = [];
  for (const raw of p.conditions) {
    const condition = parseCondition(raw);
    if (!condition) return null;
    if (!conditions.includes(condition)) conditions.push(condition);
  }
  const reason = typeof p.reason === "string" ? p.reason.replace(/\s+/g, " ").trim() : "";
  if (!reason) return null;
  return { dependency, conditions, reason: reason.slice(0, REASON_MAX_LENGTH) };
}

/** 通常の実装依存の既定条件（#4570）。依存先の実装PRが統合ブランチ（develop）へマージ済み */
export const DEFAULT_IMPLEMENTATION_CONDITIONS: readonly DependencyWaitCondition[] = ["merged"];

/** 統合ブランチの既定名。`develop`が無いリポジトリは`observeDependency`がデフォルトブランチを渡す */
export const DEFAULT_INTEGRATION_BRANCH = "develop";

/** Issue参照から`issue-<番号>`ブランチで解決した実装PRの1件分の観測 */
export type ImplementationPrObservation = {
  number: number;
  merged: boolean;
  baseRef: string | null;
  inProduction: boolean | null;
};

/** 依存先の観測結果。取得できなかった項目は`null` */
export type DependencyObservation = {
  state: "open" | "closed";
  /** PRがマージ済みか。Issueでは`null` */
  merged: boolean | null;
  baseRef: string | null;
  /** マージ済みPRの内容が本番ブランチ（main）へ入っているか。PRでなければ`null` */
  inProduction: boolean | null;
  /** 開発の統合ブランチ（既定`develop`）。`undefined`/`null`は統合ブランチを確認できなかった観測で、`merged`は成立にしない（人の確認待ち） */
  integrationBranch?: string | null;
  /** 依存先がIssueのとき、実装ブランチ（`issue-<番号>`）から解決したPR。未解決は`undefined`/`null` */
  implementationPrs?: ImplementationPrObservation[] | null;
  /** 実装PRの解決に失敗した理由。成立とは扱わない */
  implementationError?: string | null;
};

export type ConditionResult = {
  condition: DependencyWaitCondition;
  /** `true`成立 / `false`未成立 / `null`機械では判断できない（人の確認が要る） */
  satisfied: boolean | null;
  detail: string;
};

function prRef(n: number): string {
  return `PR #${n}`;
}

/**
 * 実装PR（1件以上）に対して`merged`/`released`を評価する。**全てのPRが条件を満たしたときだけ成立**
 * （無関係な1件のマージで成立させない）。mainへのマージはdevelopへのマージとはみなさない。
 */
function evaluatePrSet(
  condition: "merged" | "released",
  prs: readonly ImplementationPrObservation[],
  integrationBranch: string | null,
): ConditionResult {
  const pending = prs.filter((pr) => !pr.merged);
  if (pending.length > 0) {
    return {
      condition,
      satisfied: false,
      detail: `${pending.map((pr) => prRef(pr.number)).join("、")}がまだマージされていません`,
    };
  }
  if (condition === "merged") {
    // 統合ブランチを確定できない観測では、developへ取り込まれた証拠が無い。成立とも未成立とも言わない
    if (!integrationBranch) {
      return { condition, satisfied: null, detail: "統合ブランチを確認できないため、developへのマージを判断できません" };
    }
    const wrongBase = prs.filter((pr) => pr.baseRef !== integrationBranch);
    if (wrongBase.length > 0) {
      return {
        condition,
        satisfied: false,
        detail: `${wrongBase.map((pr) => `${prRef(pr.number)}は${pr.baseRef ?? "不明"}`).join("、")}へのマージで、${integrationBranch}へはマージされていません`,
      };
    }
    return {
      condition,
      satisfied: true,
      detail: `${prs.map((pr) => prRef(pr.number)).join("、")}が${integrationBranch}へマージ済み`,
    };
  }
  if (prs.some((pr) => pr.inProduction === null)) {
    return { condition, satisfied: null, detail: "mainへの反映を確認できませんでした" };
  }
  const notYet = prs.filter((pr) => pr.inProduction !== true);
  return notYet.length === 0
    ? { condition, satisfied: true, detail: "mainへ反映済み" }
    : {
        condition,
        satisfied: false,
        detail: `${notYet.map((pr) => prRef(pr.number)).join("、")}は${prs[0].baseRef ?? "develop"}へマージ済みですが、mainへは未反映です`,
      };
}

export function evaluateConditions(
  conditions: readonly DependencyWaitCondition[],
  dependency: DependencyRef,
  observation: DependencyObservation,
): ConditionResult[] {
  const integration = observation.integrationBranch ?? null;
  return conditions.map((condition): ConditionResult => {
    switch (condition) {
      case "closed":
        return observation.state === "closed"
          ? { condition, satisfied: true, detail: "クローズ済み" }
          : { condition, satisfied: false, detail: "まだオープン" };
      case "merged":
      case "released": {
        if (dependency.kind === "pr") {
          if (!observation.merged) return { condition, satisfied: false, detail: "まだマージされていません" };
          return evaluatePrSet(
            condition,
            [
              {
                number: dependency.number,
                merged: true,
                baseRef: observation.baseRef,
                inProduction: observation.inProduction,
              },
            ],
            integration,
          );
        }
        // 依存先がIssue: 実装ブランチのPRへ解決できたときだけ評価する。クローズ・PR作成・取得失敗は成立にしない
        if (observation.implementationError) {
          return { condition, satisfied: null, detail: `実装PRを確認できません（${observation.implementationError}）` };
        }
        if (observation.implementationPrs === undefined || observation.implementationPrs === null) {
          return {
            condition,
            satisfied: null,
            detail: "依存先がPRではなく、実装PRも解決できていないため、機械では判断できません",
          };
        }
        if (observation.implementationPrs.length === 0) {
          return observation.state === "closed"
            ? { condition, satisfied: null, detail: "実装PRが無いままクローズされています。人の確認が必要です" }
            : { condition, satisfied: false, detail: "実装PRがまだありません" };
        }
        return evaluatePrSet(condition, observation.implementationPrs, integration);
      }
      case "verified":
        return { condition, satisfied: null, detail: "実環境での検証は人の確認が必要です" };
    }
  });
}

export type DependencyWaitDecision = "wait" | "needs_confirm" | "resume";

/**
 * 条件ごとの結果から次の動きを決める。
 *
 * 1つでも未成立があれば待つ（何が残るかを表示する）。未成立が無く、機械で判断できない条件だけが
 * 残るなら**人の確認へ回し、自動では再開しない**。全部成立したときだけ再開する。
 */
export function decideDependencyWait(results: readonly ConditionResult[]): DependencyWaitDecision {
  if (results.some((r) => r.satisfied === false)) return "wait";
  if (results.some((r) => r.satisfied === null)) return "needs_confirm";
  return "resume";
}

export function formatDependencyRef(ref: DependencyRef): string {
  return `${ref.repository}#${ref.number}`;
}

export function buildDependencyUrl(ref: DependencyRef): string {
  return `https://github.com/${ref.repository}/${ref.kind === "pr" ? "pull" : "issues"}/${ref.number}`;
}

/**
 * 条件が成立したセッションへ送る固定の1行（`DispatchJob.instruction`は改行なし1行・500文字以内）。
 * 依存先の参照だけが入り、検証済みの形（`owner/repo#番号`）に限る。本文の仕様は送らず、
 * 「最新の依存先と関連コメント・元Issueの要件を読み直せ」と指示する。
 */
export function buildDependencyResumeInstruction(ref: DependencyRef): string {
  return `依存先 ${formatDependencyRef(ref)} の再開条件が成立しました。依存先の最新の内容と関連コメント、このIssueの要件を読み直して、実装を再開してください。`;
}

export type DependencyWaitView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  dependency: DependencyRef;
  dependencyUrl: string;
  conditions: DependencyWaitCondition[];
  reason: string;
  status: DependencyWaitStatus;
  source: "session" | "manual";
  results: ConditionResult[];
  lastCheckedAt: string | null;
  lastError: string | null;
  failureReason: string | null;
  resumeRequestedAt: string | null;
  resumeSentAt: string | null;
  resumedAt: string | null;
  /** 再開条件を見直した履歴（#4570）。見直していなければ空 */
  conditionHistory?: DependencyConditionRevision[];
};

export type DependencyConditionRevision = {
  at: string;
  by: string | null;
  before: DependencyWaitCondition[];
  after: DependencyWaitCondition[];
  reason: string;
};

const WAIT_TARGET_SUFFIX: Record<DependencyWaitCondition, string> = {
  closed: "のクローズ待ち",
  merged: "のdevelopマージ待ち",
  released: "の本番反映待ち",
  verified: "の検証待ち",
};

/** 「#Aのdevelopマージ待ち」のように、条件を区別して表す（PC・スマホ共通） */
export function describeWaitTarget(ref: DependencyRef, condition: DependencyWaitCondition): string {
  return `#${ref.number}${WAIT_TARGET_SUFFIX[condition]}`;
}

/**
 * 既存の`closed`だけの待ちのうち、通常の実装の取り込み待ちとして`merged`へ見直せる候補か（#4570）。
 * **`closed`単独のIssue依存だけ**。本番反映・検証を含む明示的な条件や、PR参照は対象にしない
 * （意図不明のものを一括で書き換えない）。見直しは人が1件ずつ確認して行う。
 */
export function isClosedWaitReviewCandidate(view: Pick<DependencyWaitView, "conditions" | "dependency" | "status">): boolean {
  return (
    (view.status === "WAITING" || view.status === "NEEDS_CONFIRM") &&
    view.dependency.kind === "issue" &&
    view.conditions.length === 1 &&
    view.conditions[0] === "closed"
  );
}

export type DependencyWaitNotice = {
  /** 一覧のバッジ用の短い文言 */
  shortLabel: string;
  label: string;
  /** `pending`は待機中（アニメーションを付けない）、`attention`は人の対応が要る */
  tone: "pending" | "attention" | "progress" | "done";
  /** 次に何が起きるか */
  nextStep: string;
};

export function describeDependencyWait(view: DependencyWaitView): DependencyWaitNotice {
  const remaining = view.results.filter((r) => r.satisfied !== true);
  const remainingText = remaining.length
    ? remaining.map((r) => `${describeWaitTarget(view.dependency, r.condition)}（${r.detail}）`).join("、")
    : null;
  switch (view.status) {
    case "WAITING":
      return {
        shortLabel: "依存待ち",
        label: "依存待ち",
        tone: "pending",
        nextStep: remainingText
          ? `残りの条件: ${remainingText}。成立すると自動で実装を再開します。操作は不要です。`
          : "条件を確認中です。成立すると自動で実装を再開します。",
      };
    case "NEEDS_CONFIRM":
      return {
        shortLabel: "依存待ち・要確認",
        label: "依存待ち（人の確認が必要）",
        tone: "attention",
        nextStep: remainingText
          ? `自動では判断できない条件が残っています: ${remainingText}。確認できたら「作業を再開」を押してください。`
          : "確認できたら「作業を再開」を押してください。",
      };
    case "RESUME_REQUESTED":
      return {
        shortLabel: "再開を要求中",
        label: "条件が成立し、再開を要求しました",
        tone: "progress",
        nextStep: "セッションへの指示の送信を待っています。",
      };
    case "RESUME_SENT":
      return {
        shortLabel: "再開を送信済み",
        label: "再開の指示を送信しました",
        tone: "progress",
        nextStep: "セッションが実際に動き出したことを確認します。",
      };
    case "RESUMED":
      return {
        shortLabel: "再開済み",
        label: "実装を再開しました",
        tone: "done",
        nextStep: "依存待ちは解消しました。",
      };
    case "RESUME_FAILED":
      return {
        shortLabel: "再開に失敗",
        label: "再開に失敗しました",
        tone: "attention",
        nextStep: `${view.failureReason ?? "理由を取得できませんでした"}。「作業を再開」で再試行できます。`,
      };
    case "CANCELLED":
      return {
        shortLabel: "待機を解除",
        label: "依存待ちを解除しました",
        tone: "done",
        nextStep: "このIssueはもう依存先を待っていません。",
      };
  }
}

/**
 * 「保留コメントと`11.local`だけが残る」既存の保留（#687相当）の依存先候補を、コメントから拾う。
 *
 * **自由文からの推定なので、結果は「要確認の候補」としてしか使わない。** 見つかっても自動では
 * 待機を登録せず、再開もしない。保留を述べる語（保留・待つ・待機）と、`owner/repo#番号`か
 * GitHubのURLが同じコメントにあるものだけを候補にする。
 */
export function detectLegacyHoldCandidate(
  commentBodies: readonly string[],
): { dependency: DependencyRef; excerpt: string } | null {
  for (let i = commentBodies.length - 1; i >= 0; i -= 1) {
    const body = commentBodies[i];
    if (!/保留|待機|待つ|待ち/.test(body)) continue;
    const url = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/.exec(body);
    const short = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/.exec(body);
    const dependency: DependencyRef | null = url
      ? { repository: url[1], number: Number(url[3]), kind: url[2] === "pull" ? "pr" : "issue" }
      : short
        ? { repository: short[1], number: Number(short[2]), kind: "issue" }
        : null;
    if (!dependency) continue;
    const line = body.split("\n").find((l) => /保留|待機|待つ|待ち/.test(l)) ?? body;
    return { dependency, excerpt: line.trim().slice(0, 160) };
  }
  return null;
}
