import type {
  ClaudeWindowKeepAliveSettings,
  ClaudeWindowKeepAliveView,
} from "@/lib/claude-window-keepalive";
import type { DispatchJobStatus } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionState } from "@/lib/dispatch/session-state";
import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_TEXT,
  checkUserReason,
} from "@/lib/github/approval-labels";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import {
  ARTIFACT_REQUIRED_LABEL,
  PREVIEW_REQUIRED_LABEL,
  START_IMPLEMENTATION_OPTIONS,
} from "@/lib/github/start-implementation";
import { matchProjectStatus } from "@/lib/issue-progress";
import {
  describeNextWindowRunMarkChip,
  describeNextWindowRunMarkDetail,
  describeNextWindowRunMarkTitle,
  type NextWindowRunQueuedMark,
  type NextWindowRunSettings,
  type NextWindowRunWindowView,
} from "@/lib/next-window-run";

/**
 * 予約実行（次枠実行 #2995）の共有判定。**時刻を見る判定はすべて`now`を引数で受け取る。**
 *
 * かつては「今夜の夜間実行」（時計で決まる窓）も同じ表・同じ画面で扱っていたが#3019で削除した。
 * ここに残る型・関数は、削除後も次枠実行（`next-window-run.ts`）と共有しているもの。
 */

/** 結果を残す日数。これより古い予定の行は起動処理の巡回で消す */
export const NIGHTLY_RUN_RESULT_RETENTION_DAYS = 30;

/**
 * 予定の種類（#2995）。`ScheduledRunKind`（Prisma）と同じ語。
 *
 * `NIGHTLY`＝今夜の夜間実行（時計で決まる窓）／`NEXT_WINDOW`＝次の5時間枠
 * （Claudeのプラン枠のリセット時刻で決まる窓。判定は`next-window-run.ts`）。
 */
export type ScheduledRunKind = "NIGHTLY" | "NEXT_WINDOW";

/** 種類の呼び名。見送り理由や画面の文言に埋める */
export const SCHEDULED_RUN_KIND_NAMES: Record<ScheduledRunKind, string> = {
  NIGHTLY: "夜間実行",
  NEXT_WINDOW: "次枠実行",
};

/**
 * 予約実行では進められないオプションのラベル。**人がその場にいないと止まるもの**に限る。
 *
 * - `23.preview-required`: 開発サーバーを起こして画面を確認してもらう工程で止まる。
 *   `merge-policy: relaxed`でも自動マージが止まる
 * - `25.artifact-required`: 見た目の承認を待つ工程で止まる
 *
 * `22.merge-confirm-required`（自分の目で通すための札）は入れない。`21.plan-required`も
 * 入れない——計画の投稿で止まって後から承認する、という使い方は予約実行の想定に含まれる。
 */
export const NIGHTLY_RUN_BLOCKING_LABELS: readonly string[] = [
  PREVIEW_REQUIRED_LABEL,
  ARTIFACT_REQUIRED_LABEL,
];

function optionLabelTitle(name: string): string {
  return START_IMPLEMENTATION_OPTIONS.find((option) => option.githubLabel === name)?.label ?? name;
}

/**
 * 付いているラベルのうち、予約実行では進められないものがあればその理由を返す。
 * 積むとき（ダイアログ・API）と起動するとき（あとから付いたもの）の両方で使う。
 *
 * 枠のリセット時刻は時計と無関係なので、起動が深夜になるか昼になるかを積む時点では決められない。
 * 人が居ることを前提にできない（#2995）。
 */
export function resolveNightlyRunLabelRejection(
  labels: readonly { name: string }[],
  kind: ScheduledRunKind,
): string | null {
  const blocking = labels
    .map((label) => label.name)
    .filter((name) => NIGHTLY_RUN_BLOCKING_LABELS.includes(name));
  if (blocking.length === 0) return null;
  const titles = blocking.map((name) => `「${optionLabelTitle(name)}」`).join("・");
  return `${titles}は${SCHEDULED_RUN_KIND_NAMES[kind]}では進められません（承認・確認を待つ人がいない）。ラベルを外してから積んでください`;
}

export type NightlyRunLaunchDecision = { action: "launch" } | { action: "skip"; reason: string };

/**
 * Issueの状態を取れなかったときの見送り理由。原因ごとに分ける（#3148）——以前は一律
 * 「認証が切れている可能性」と出しており、延長すれば通る失敗なのか、人が再ログインしないと
 * 通らない失敗なのかが画面から分からなかった。
 */
function describeIssueFetchFailure(failure: "reauth_required" | "api_error" | null): string {
  if (failure === "reauth_required") {
    return "GitHubの認証が切れていて、自動での延長もできませんでした。issue-deckへログインし直してから積み直してください";
  }
  if (failure === "api_error") {
    return "GitHubへの問い合わせに失敗しました（一時的な障害の可能性があります）";
  }
  return "Issueを取得できませんでした（削除・移動された可能性があります）";
}

/**
 * 起動する時点で、その予定を起動してよいか。**読むのはGitHub上の実ラベルとIssueの開閉。**
 *
 * 積んだ時点の判定と重ねて置くのは、窓が開くまでのあいだに状況が変わるため（別のセッションで
 * 着手した・closeした・承認待ちになった・`25.artifact-required`が付いた）。判定できない
 * （`issueState`が`null`＝取れなかった）ときは見送る——起動してから止まるより、後で「見送り」と
 * 出る方が軽い。
 */
export function decideNightlyRunLaunch(input: {
  issueState: "open" | "closed" | null;
  labels: readonly { name: string }[];
  /** 予定の種類（#2995）。見送り理由の文言だけが変わる */
  kind: ScheduledRunKind;
  /**
   * `issueState`が`null`になった理由（#3148）。`reauth_required`＝トークンの延長にも失敗した／
   * `api_error`＝GitHubへの問い合わせ自体が失敗した。省略時はIssueを引けなかった（404等）扱い
   */
  fetchFailure?: "reauth_required" | "api_error" | null;
}): NightlyRunLaunchDecision {
  if (input.issueState === null) {
    return { action: "skip", reason: describeIssueFetchFailure(input.fetchFailure ?? null) };
  }
  if (input.issueState === "closed") {
    return { action: "skip", reason: "Issueがcloseされていました" };
  }
  const names = input.labels.map((label) => label.name);
  if (names.includes(LOCAL_LABEL_NAME)) {
    return { action: "skip", reason: `すでに別のセッションで着手済みでした（${LOCAL_LABEL_NAME}）` };
  }
  if (names.includes(CHECK_USER_LABEL)) {
    const reason = checkUserReason(input.labels);
    return {
      action: "skip",
      reason: `確認待ち（${reason ? CHECK_USER_REASON_TEXT[reason] : CHECK_USER_LABEL}）のままでした`,
    };
  }
  const labelRejection = resolveNightlyRunLabelRejection(input.labels, input.kind);
  if (labelRejection) return { action: "skip", reason: labelRejection };
  return { action: "launch" };
}

/**
 * 予定を積んだ後に、そのIssueが手動で実装開始されていないか（#3274）。開始されていれば、
 * 予定を取り消す理由（`skipReason`に残す文）を返す。
 *
 * 手動の開始は2つの形で見える。どちらも起動処理（`launchScheduledRunEntry`）を通らない
 * ——通るなら予定が`nightKey`を握っている最中で、呼び出し側が対象から外している。
 * - `11.local`が付いた（「実装を開始」・ローカルセッションのどちらも必ず付ける）
 * - 予定を積んだ後に、生きている起動ジョブが作られた（`11.local`の付与に失敗した場合の保険）
 *
 * 起動する時点の判定（`decideNightlyRunLaunch`）は同じ`11.local`を見て「見送り」にしていたが、
 * それだと枠が開くまで予定が画面に残り続ける。着手の時点で外すために、判定を前へ出した。
 */
export function decideManualStartCancel(input: {
  labels: readonly { name: string }[];
  /** 予定を積んだ後に作られた、失敗・取り消しで終わっていない起動ジョブがあるか */
  hasLaunchJobSinceQueued: boolean;
}): string | null {
  if (input.labels.some((label) => label.name === LOCAL_LABEL_NAME)) {
    return `手動で実装が開始されたため、予約を取り消しました（${LOCAL_LABEL_NAME}）`;
  }
  if (input.hasLaunchJobSinceQueued) {
    return "手動で実装が開始されたため、予約を取り消しました（起動ジョブ）";
  }
  return null;
}

export type NightlyRunEntryStatus = "QUEUED" | "LAUNCHED" | "SKIPPED" | "CANCELED";

export type NightlyRunOutcomeKind = "ok" | "warn" | "run" | "bad" | "skip";

/** 5分類の見出し。並びは画面に出す順（自動で解決したもの → 人が動くもの） */
export const NIGHTLY_RUN_OUTCOME_ORDER: readonly NightlyRunOutcomeKind[] = [
  "ok",
  "warn",
  "run",
  "bad",
  "skip",
];

export const NIGHTLY_RUN_OUTCOME_LABELS: Record<NightlyRunOutcomeKind, string> = {
  ok: "本番反映待ち",
  warn: "確認が必要",
  run: "実行中",
  bad: "止まった",
  skip: "見送り",
};

export const NIGHTLY_RUN_OUTCOME_DESCRIPTIONS: Record<NightlyRunOutcomeKind, string> = {
  ok: "自動で解決したもの。developへマージ済みで、次のリリースPRに含まれます",
  warn: "人が動くまで進まないもの。理由はいつもの確認待ちと同じです",
  run: "まだセッションが動いている、またはPRの自動レビュー・マージを待っているもの",
  bad: "セッションが最後まで走らなかったもの",
  skip: "起動する時点で条件を満たさなかったもの。必要なら積み直します",
};

export type NightlyRunOutcome = { kind: NightlyRunOutcomeKind; detail: string };

/**
 * 夜に起動した（または見送った）予定の、いまの結果を5つに分ける。
 *
 * 材料はDBにあるものだけ（Issueの同期済みの状態・ジョブ・セッション）。GitHubへは問い合わせない。
 * **判定の順は「確定したものから」**——見送り → closeされた → 確認待ち → 進捗Status → セッション・
 * ジョブの状態。確認待ちを進捗より先に見るのは、`Develop PR`で`22.merge-confirm-required`により
 * 止まっているものを「実行中」ではなく「確認が必要」に出すため。
 */
export function classifyNightlyRunOutcome(input: {
  entry: { status: NightlyRunEntryStatus; skipReason: string | null };
  issue: {
    state: "OPEN" | "CLOSED";
    projectStatus: string | null;
    labels: readonly { name: string }[];
  } | null;
  job: { status: DispatchJobStatus } | null;
  session: { state: DispatchSessionState } | null;
}): NightlyRunOutcome {
  const { entry, issue, job, session } = input;
  if (entry.status === "SKIPPED") {
    return { kind: "skip", detail: entry.skipReason ?? "見送りました" };
  }
  if (entry.status === "CANCELED") {
    return { kind: "skip", detail: "取り消しました" };
  }
  if (entry.status === "QUEUED") {
    return { kind: "run", detail: "起動を待っています" };
  }
  if (!issue) {
    return { kind: "bad", detail: "Issueの情報が見つかりません" };
  }

  const progress = issue.projectStatus ? matchProjectStatus(issue.projectStatus) : null;
  if (issue.state === "CLOSED") {
    return progress === "done"
      ? { kind: "ok", detail: "本番へ反映済み（Issueはclose）" }
      : { kind: "skip", detail: "Issueがcloseされました" };
  }

  if (issue.labels.some((label) => label.name === CHECK_USER_LABEL)) {
    const reason = checkUserReason(issue.labels);
    return { kind: "warn", detail: reason ? `${CHECK_USER_REASON_TEXT[reason]}待ち` : "確認待ち" };
  }

  if (progress === "develop" || progress === "release" || progress === "done") {
    return { kind: "ok", detail: "developへマージ済み" };
  }
  if (progress === "develop-pr") {
    return { kind: "run", detail: "PRの自動レビュー・マージを待っています" };
  }

  if (session?.state === "FAILED") {
    return { kind: "bad", detail: "セッションが異常終了しました（PRなし）" };
  }
  if (session?.state === "EXITED" || session?.state === "GONE") {
    return { kind: "bad", detail: "セッションが終了しましたが、PRが作られていません" };
  }
  if (session?.state === "ALIVE") {
    return { kind: "run", detail: "セッションが動いています" };
  }
  if (job?.status === "FAILED" || job?.status === "TIMEOUT" || job?.status === "CANCELED") {
    return { kind: "bad", detail: "セッションを起動できませんでした" };
  }
  if (job?.status === "QUEUED" || job?.status === "CLAIMED" || job?.status === "RUNNING") {
    return { kind: "run", detail: "サブPCでの起動を待っています" };
  }
  return { kind: "run", detail: "状態を確認しています" };
}

/** 「予約実行」画面が読み書きする設定のひとまとまり（`GET`/`PATCH /api/nightly-run/settings`） */
export type ScheduledRunSettings = {
  nextWindow: NextWindowRunSettings;
  /** 5時間枠を開けておく（#3032） */
  keepAlive: ClaudeWindowKeepAliveSettings;
};

/** 画面に出す予定・結果1件ぶん */
export type NightlyRunEntryView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  /** 同期済みのIssueから引けたときだけ入る（`DispatchJobView.issueId`と同じ扱い） */
  issueId: string | null;
  issueTitle: string | null;
  targetHost: string;
  agent: string;
  claudeModel: string | null;
  /** #3192。`agent`がcodexのとき、積んだときに指定したモデル（nullは設定に従う） */
  codexModel?: string | null;
  optionLabels: string[];
  kind: ScheduledRunKind;
  status: NightlyRunEntryStatus;
  /** 起動・見送りした回のグループ鍵（夜なら`YYYY-MM-DD`、次枠なら`YYYY-MM-DD HH:mm`） */
  nightKey: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** 結果の分類。予定（QUEUED）では`null` */
  outcome: NightlyRunOutcome | null;
};

/** 予定と結果の1組（画面もこの単位で描く） */
export type ScheduledRunSection = {
  /** 予定（積んだ順） */
  queued: NightlyRunEntryView[];
  /** 直近の1回ぶんの結果。まだ一度も走っていなければ`null` */
  results: { runKey: string; entries: NightlyRunEntryView[] } | null;
};

/**
 * 「予約実行」画面の状態。
 *
 * かつては夜間実行（時計の窓）と次枠実行（枠の窓）の2種類を1つの状態にまとめていたが、
 * #3019で夜間実行を削除したため次枠実行の1種類だけが残る。
 */
export type NightlyRunState = {
  /** 次の5時間枠の予定と結果（#2995） */
  nextWindow: ScheduledRunSection & {
    settings: NextWindowRunSettings;
    /** いまの5時間枠の状況。取りに行かなかった・取れなかったときは`null` */
    window: NextWindowRunWindowView | null;
  };
  /** 5時間枠を開けておく（#3032） */
  keepAlive: ClaudeWindowKeepAliveView;
};

/**
 * 結果を分類ごとに数える。画面の要約（4枠）に使う。
 */
export function summarizeNightlyRunOutcomes(
  entries: readonly NightlyRunEntryView[],
): Record<NightlyRunOutcomeKind, number> {
  const counts: Record<NightlyRunOutcomeKind, number> = { ok: 0, warn: 0, run: 0, bad: 0, skip: 0 };
  for (const entry of entries) {
    if (entry.outcome) counts[entry.outcome.kind] += 1;
  }
  return counts;
}

/**
 * 処理済みの予定から「直近の夜」の鍵を選ぶ。`nightKey`の辞書順が日付順になる形にしてあるので、
 * 最大値がそのまま最新の夜。
 */
export function selectLatestNightKey(
  entries: readonly { status: NightlyRunEntryStatus; nightKey: string | null }[],
): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.status !== "LAUNCHED" && entry.status !== "SKIPPED") continue;
    if (!entry.nightKey) continue;
    if (latest === null || entry.nightKey > latest) latest = entry.nightKey;
  }
  return latest;
}

/** `optionLabels`列（JSON）を文字列の配列として読む。壊れていれば空 */
export function parseNightlyRunOptionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Issue一覧・Issue詳細に出す「予約実行に積まれている」の目印（#2866・#2995）。
 *
 * 積んでも**ラベル・ジョブ・セッションのどれも付かない**（`nightly-run-launch.ts`。付けると
 * 起動していないのに無人実行まで止まる）ため、積んだIssueは一覧でも詳細でも、まだ何も指示して
 * いないIssueとまったく同じ姿で並んでいた。目印だけをここから配る。
 *
 * **出すのは`QUEUED`の予定だけ。** 起動した後は進捗バー・セッションの表示が受け持つので、
 * 目印を重ねると同じことを2か所で言うことになる
 * （`docs/code-map.md`「同じ状態を2か所で言わせない。誰が言うかは並べる側が決める」）。
 */
export type ScheduledRunQueuedMark = {
  /** 取り消し（`DELETE /api/nightly-run/:id`）に使う予定の識別子 */
  entryId: string;
  kind: ScheduledRunKind;
  /** その種類の予約実行そのものが有効か。OFFなら積んであっても起動しない */
  enabled: boolean;
  /** 一覧の行のチップに出す短い文言 */
  chip: string;
  /** 見出し（チップのツールチップ・詳細の1行目） */
  title: string;
  /** 詳細に添える説明 */
  detail: string;
};

/**
 * `Issue.id`（＝`String(githubIssueId)`）で引く表。
 *
 * **`owner/repo#番号`の鍵を新しく作らない**（計画レビューG1の指摘）。同じ形式は
 * `NightlyRunEntry.activeKey`（`nightly-run-db.ts`）と`issue-queue-state.ts`に既にあり、
 * ここへ3つ目を足すと定義が散る。`NightlyRunEntryView.issueId`は画面の`Issue.id`と同じ
 * 識別子なので（`issue-mapper.ts`）、そのまま鍵に使える。
 */
export type ScheduledRunQueuedMap = ReadonlyMap<string, ScheduledRunQueuedMark>;

/**
 * 予定から引き当て表を作る。取得前（`state`が`null`）は空の表になり、目印は出ない。
 *
 * 同期できていないIssue（`issueId`が`null`）は表へ入れない。そのIssueはそもそも一覧にも
 * 詳細にも出ないので、目印を引く相手がいない。
 */
export function selectScheduledRunQueuedMarks(state: Pick<NightlyRunState, "nextWindow"> | null): ScheduledRunQueuedMap {
  const marks = new Map<string, ScheduledRunQueuedMark>();
  if (!state) return marks;

  for (const entry of state.nextWindow.queued) {
    if (entry.status !== "QUEUED" || !entry.issueId) continue;
    const mark: NextWindowRunQueuedMark = {
      entryId: entry.id,
      enabled: state.nextWindow.settings.enabled,
      opensAt: state.nextWindow.window?.opensAt ?? null,
      phase: state.nextWindow.window?.phase ?? "unknown",
    };
    marks.set(entry.issueId, {
      entryId: entry.id,
      kind: "NEXT_WINDOW",
      enabled: mark.enabled,
      chip: describeNextWindowRunMarkChip(mark),
      title: describeNextWindowRunMarkTitle(mark),
      detail: describeNextWindowRunMarkDetail(mark),
    });
  }

  return marks;
}

export function findScheduledRunQueuedMark(
  marks: ScheduledRunQueuedMap | undefined,
  issueId: string,
): ScheduledRunQueuedMark | null {
  return marks?.get(issueId) ?? null;
}

/**
 * 一覧から予約実行へまとめて積む（#3284）ときの、行ごとの「選べない理由」。選べるなら`null`。
 *
 * 積む口は「実装を開始」ダイアログと同じ`POST /api/nightly-run`で、そこでも同じ判定をする。
 * ここは**押す前に行へ理由を出す**ための判定で、ラベルの塞ぎ方は
 * `resolveNightlyRunLabelRejection`をそのまま使う（2か所に書かない）。
 */
export function resolveBulkReserveRejection(input: {
  state: "open" | "closed";
  labels: readonly { name: string }[];
  /** 予約実行にすでに積まれているか（`selectScheduledRunQueuedMarks`の引き当て表に載っているか） */
  alreadyQueued: boolean;
  /** 起動ジョブが未完了・セッションが動いているなど、いま実行中か待機中か */
  isActive: boolean;
  /** そのリポジトリを実行できるホストがあるか */
  hasHost: boolean;
  /** 使うエージェント（既定はclaude）。Codexのとき、対応ホストが無い理由を出し分ける */
  agent?: "claude" | "codex";
}): string | null {
  if (input.state === "closed") return "closeされています";
  if (input.alreadyQueued) return "予約済みです";
  const names = input.labels.map((label) => label.name);
  if (names.includes(LOCAL_LABEL_NAME)) return `着手済みです（${LOCAL_LABEL_NAME}）`;
  if (input.isActive) return "実行中、または実行待ちです";
  if (names.includes(CHECK_USER_LABEL)) {
    const reason = checkUserReason(input.labels);
    return `確認待ち（${reason ? CHECK_USER_REASON_TEXT[reason] : CHECK_USER_LABEL}）のため積めません`;
  }
  const labelRejection = resolveNightlyRunLabelRejection(input.labels, "NEXT_WINDOW");
  if (labelRejection) return labelRejection;
  if (!input.hasHost) {
    return input.agent === "codex"
      ? "このリポジトリをCodexで実行できるサブPCがありません"
      : "このリポジトリを実行できるサブPCが登録されていません";
  }
  return null;
}

/** 起動先のホスト。「実装を開始」ダイアログの`nightlyHost`と同じく、そのリポジトリを持つ先頭のホスト */
export function pickBulkReserveHost(
  hosts: readonly { name: string; repositories: readonly string[]; codexCapable?: boolean | null }[],
  repositoryFullName: string,
  agent: "claude" | "codex" = "claude",
): string | null {
  // Codexは`codex`コマンドのあるホストだけ（`POST /api/nightly-run`の`resolveDispatchAgentRejection`と同じ条件）
  return (
    hosts.find(
      (host) =>
        host.repositories.includes(repositoryFullName) &&
        (agent !== "codex" || host.codexCapable === true),
    )?.name ?? null
  );
}

export type BulkReserveTarget = {
  issueId: string;
  repositoryFullName: string;
  number: number;
  host: string;
};

export type BulkReserveResult =
  | { issueId: string; ok: true }
  | { issueId: string; ok: false; message: string };

/**
 * 選んだIssueを**1件ずつ順に**積む。積む処理（`reserve`）は呼び出し側が渡す。
 *
 * 並列にしないのは、`reservedResetsAt`を積む時点の枠から控える処理が件数ぶん同じ行を読み、
 * 失敗の理由を行と対応づけて残しやすいため（数十件までしか選ばない想定）。1件の失敗で
 * 後続を止めず、`reserve`が例外を投げても失敗として記録して続ける。
 */
export async function reserveIssuesSequentially(
  targets: readonly BulkReserveTarget[],
  reserve: (target: BulkReserveTarget) => Promise<{ ok: true } | { ok: false; message: string }>,
): Promise<BulkReserveResult[]> {
  const results: BulkReserveResult[] = [];
  for (const target of targets) {
    try {
      const outcome = await reserve(target);
      results.push(
        outcome.ok
          ? { issueId: target.issueId, ok: true }
          : { issueId: target.issueId, ok: false, message: outcome.message },
      );
    } catch (err) {
      results.push({
        issueId: target.issueId,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
