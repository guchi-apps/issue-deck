import { decideDependencyWait, type ConditionResult, type DependencyWaitCondition } from "@/lib/dispatch/dependency-wait";
import type { PlanChild, PlanDependency, PlanSnapshot } from "@/lib/execution-plan/types";
import { formatRef, refKey } from "@/lib/execution-plan/types";
import { isNonCodeWorkVerified, isTimedNonCodeWork } from "@/lib/execution-plan/release-link";

/**
 * 親Issueの自動実行（#4536）の判断。副作用を持たない純関数だけを置く。
 *
 * **完了の語彙は#4321の`closed/merged/released/verified`をそのまま使う**（二重の完了定義を作らない）。
 * 子のクローズ・PR作成だけでは次へ進めず、計画が指定した条件の証拠が揃ったときだけ後続を起動する。
 * 取得に失敗した対象は「完了」「依存なし」と解釈せず、待機理由に残す。
 */

export const PARENT_RUN_STATUSES = ["RUNNING", "PAUSED", "STOPPED", "COMPLETED"] as const;
export type ParentRunStatus = (typeof PARENT_RUN_STATUSES)[number];

export const CHILD_LAUNCH_STATES = ["PENDING", "LAUNCHING", "LAUNCHED", "LAUNCH_FAILED", "SKIPPED"] as const;
export type ChildLaunchState = (typeof CHILD_LAUNCH_STATES)[number];

export function parseParentRunStatus(value: unknown): ParentRunStatus | null {
  return typeof value === "string" && (PARENT_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as ParentRunStatus)
    : null;
}

export function parseChildLaunchState(value: unknown): ChildLaunchState {
  return typeof value === "string" && (CHILD_LAUNCH_STATES as readonly string[]).includes(value)
    ? (value as ChildLaunchState)
    : "PENDING";
}

/** 子の実装PR（`issue-<番号>`ブランチ）の解決結果。`error`は取得失敗で、成立とは解釈しない */
export type PrResolution =
  | { kind: "none" }
  | { kind: "one"; number: number; merged: boolean; inProduction: boolean | null; integration?: boolean }
  | { kind: "many"; numbers: number[] }
  | { kind: "error"; message: string };

/** 1つのIssueについて、巡回が集めた観測 */
export type RefObservation = {
  issue: "open" | "closed" | "missing" | "error";
  error?: string;
  pr: PrResolution;
  /** `00.check-user`が付いている（本人の操作待ち） */
  needsUser: boolean;
  /** 起動したジョブの状態（`DispatchJob.status`）。ジョブが無ければ`null` */
  jobStatus: string | null;
  sessionAlive: boolean;
};

export type ChildPhase = "done" | "running" | "launching" | "ready" | "waiting" | "blocked" | "attention" | "skipped";

export type ChildAction = "retry" | "verify" | "user";

export type ChildDisplay = {
  phase: ChildPhase;
  /** 状態の短い名前（チップ） */
  label: string;
  /** 待機先・理由・対応先 */
  reason: string;
  /** 前提ごとの評価（待機先の表示用） */
  dependencies: { ref: string; conditions: ConditionResult[] }[];
  prNumber: number | null;
  action: ChildAction | null;
};

export type ChildInput = {
  child: PlanChild;
  launchState: ChildLaunchState;
  verifiedAt: Date | null;
  lastError: string | null;
};

const TERMINAL_JOB_STATUSES = ["FAILED", "TIMEOUT", "CANCELED", "SKIPPED"];
const ACTIVE_JOB_STATUSES = ["QUEUED", "CLAIMED", "RUNNING"];

function emptyObservation(): RefObservation {
  return { issue: "error", error: "未取得", pr: { kind: "error", message: "未取得" }, needsUser: false, jobStatus: null, sessionAlive: false };
}

/** 子が自分の実装を終えている（クローズ、または実装PRがマージ済み） */
export function isChildDone(obs: RefObservation): boolean {
  return obs.issue === "closed" || (obs.pr.kind === "one" && obs.pr.merged);
}

/** 本番（main）へ反映済み。**実装PRでmerged＋mainへの反映を確かめられた場合だけ**（Issueのクローズでは成立としない） */
export function isChildReleased(obs: RefObservation): boolean {
  return obs.pr.kind === "one" && obs.pr.merged && obs.pr.inProduction === true;
}

/**
 * 子のdevelopマージが実装PRで確かめられている。Issueのクローズだけでは成立としない（親の完了条件に使う）。
 * **統合ブランチへのマージと確かめられた場合だけ**（mainへの直接マージ・統合ブランチを確認できない場合は成立にしない）
 */
export function isChildMerged(obs: RefObservation): boolean {
  return obs.pr.kind === "one" && obs.pr.merged && obs.pr.integration === true;
}

/** 依存先1件の条件を評価する。**取得失敗・曖昧は`null`（成立とも未成立とも言わない）** */
export function evaluateDependency(
  dep: PlanDependency,
  obs: RefObservation,
  verifiedAt: Date | null,
  /** 依存先の子の区分（#4523）。PRを持たない作業（環境設定・確認）は、クローズ＋検証結果の記録で本番確認が成立する */
  target?: PlanChild,
): ConditionResult[] {
  return dep.conditions.map((condition: DependencyWaitCondition): ConditionResult => {
    const unknownIssue = obs.issue === "error" || obs.issue === "missing";
    // PRを持たない作業（#4523）: PRのマージ・main反映は存在しない。完了は「クローズ＋検証結果の記録」
    if (target && isTimedNonCodeWork(target, obs) && (condition === "released" || condition === "verified")) {
      if (unknownIssue) return { condition, satisfied: null, detail: obs.issue === "missing" ? "Issueが見つかりません" : `取得できません（${obs.error ?? "不明"}）` };
      if (obs.issue === "open") {
        return { condition, satisfied: false, detail: verifiedAt ? "検証結果は記録されていますが、Issueが再オープンされています（古い証跡は使いません）" : "作業が完了していません" };
      }
      return isNonCodeWorkVerified(obs, verifiedAt)
        ? { condition, satisfied: true, detail: "作業が完了し、検証結果が記録されています" }
        : { condition, satisfied: false, detail: "クローズ済みですが、作業の検証結果が記録されていません（クローズだけでは成立としません）" };
    }
    switch (condition) {
      case "closed":
        if (unknownIssue) return { condition, satisfied: null, detail: obs.issue === "missing" ? "Issueが見つかりません" : `取得できません（${obs.error ?? "不明"}）` };
        return obs.issue === "closed"
          ? { condition, satisfied: true, detail: "クローズ済み" }
          : { condition, satisfied: false, detail: "まだオープン" };
      case "merged":
      case "released": {
        const pr = obs.pr;
        if (pr.kind === "error") return { condition, satisfied: null, detail: `実装PRを確認できません（${pr.message}）` };
        if (pr.kind === "many") return { condition, satisfied: null, detail: `実装PRが複数あります（${pr.numbers.map((n) => `#${n}`).join(", ")}）` };
        if (pr.kind === "none") {
          return obs.issue === "closed"
            ? { condition, satisfied: null, detail: "実装PRが無いままクローズされています。人の確認が必要です" }
            : { condition, satisfied: false, detail: "実装PRがまだありません" };
        }
        if (!pr.merged) return { condition, satisfied: false, detail: `PR #${pr.number}がまだマージされていません` };
        if (condition === "merged") {
          // mainなど統合ブランチ以外へのマージは、developへのマージとはみなさない（#4570）
          if (pr.integration === undefined) return { condition, satisfied: null, detail: `PR #${pr.number}のマージ先が統合ブランチか確認できません` };
          return pr.integration
            ? { condition, satisfied: true, detail: `PR #${pr.number}がdevelopへマージ済み` }
            : { condition, satisfied: false, detail: `PR #${pr.number}は統合ブランチ（develop）以外へのマージです` };
        }
        if (pr.inProduction === null) return { condition, satisfied: null, detail: "mainへの反映を確認できませんでした" };
        return pr.inProduction
          ? { condition, satisfied: true, detail: `PR #${pr.number}がmainへ反映済み` }
          : { condition, satisfied: false, detail: `PR #${pr.number}はdevelopまで。mainへは未反映です` };
      }
      case "verified":
        // 記録だけでは成立にしない。実装PRのmerged＋mainへの反映が確かめられているときだけ（記録は保持する）
        if (verifiedAt) {
          return isChildReleased(obs)
            ? { condition, satisfied: true, detail: "本番確認が記録されています" }
            : { condition, satisfied: false, detail: "本番確認の記録はありますが、実装PRのmain反映を確認できていません" };
        }
        // 実装が終わる前は「待つ」だけ。終わってからはじめて人の確認（記録）が要る
        // 記録できるのは実装PRのmain反映を確かめられた後だけ（記録の受け口と同じ条件。押せないボタンを出さない）
        if (isChildReleased(obs)) return { condition, satisfied: null, detail: "実環境での確認が必要です（人が記録します）" };
        return isChildDone(obs)
          ? { condition, satisfied: false, detail: "実装PRのdevelopマージ・main反映を確認できていません（PRなしのクローズは本番確認の対象になりません。計画の見直しが必要です）" }
          : { condition, satisfied: false, detail: "実装がまだ完了していません" };
    }
  });
}

export type ChildEvaluation = ChildInput & { display: ChildDisplay };

export type RunEvaluationInput = {
  plan: PlanSnapshot;
  status: ParentRunStatus;
  maxParallel: number;
  children: ChildInput[];
  observations: Map<string, RefObservation>;
  parentVerifiedAt: Date | null;
};

export type CompletionEvidence = { label: string; ok: boolean; detail: string };

export type RunEvaluation = {
  children: ChildEvaluation[];
  counts: { done: number; running: number; waiting: number; attention: number; total: number };
  /** 今回起動してよい子（`refKey`）。一時停止中・停止中は空 */
  toLaunch: string[];
  /** 次に着手する対象（起動してよいもの、無ければ最初に条件が成立しそうな待機中の子） */
  next: string | null;
  completion: { complete: boolean; evidence: CompletionEvidence[] };
};

/**
 * 親の実行全体を評価する。依存先が失敗・本人操作待ちの子は後続を止め（`blocked`）、独立した子は進める。
 * 評価は2段で、先に依存のない側から自分の状態（クローズ・実行中など）を決め、依存先の状態を見て後続を決める。
 */
export function evaluateRun(input: RunEvaluationInput): RunEvaluation {
  const byKey = new Map(input.children.map((c) => [refKey(c.child), c]));
  const evaluated = new Map<string, ChildEvaluation>();

  const obsOf = (key: string) => input.observations.get(key) ?? emptyObservation();

  const evaluate = (key: string, trail: Set<string>): ChildEvaluation => {
    const cached = evaluated.get(key);
    if (cached) return cached;
    const ci = byKey.get(key) as ChildInput;
    const obs = obsOf(key);
    const prNumber = obs.pr.kind === "one" ? obs.pr.number : null;
    const mk = (phase: ChildPhase, label: string, reason: string, action: ChildAction | null = null, dependencies: ChildDisplay["dependencies"] = []): ChildEvaluation => {
      const result = { ...ci, display: { phase, label, reason, dependencies, prNumber, action } };
      evaluated.set(key, result);
      return result;
    };

    if (ci.launchState === "SKIPPED") return mk("skipped", "起動しない", "停止されたため、起動しません");
    if (obs.issue === "error") return mk("attention", "取得失敗", `Issueの状態を取得できません（${obs.error ?? "不明"}）。完了とは扱いません`);
    if (obs.issue === "missing") return mk("attention", "見つからない", "Issueが削除されたか見つかりません。計画の見直しが必要です", "user");
    if (obs.issue === "closed") {
      const via = obs.pr.kind === "one" ? `PR #${obs.pr.number}` : "クローズ";
      return mk("done", "完了", `${via}で完了済み。成果を再利用します`);
    }
    if (obs.pr.kind === "one" && obs.pr.merged) {
      if (obs.pr.integration === true) return mk("done", "完了", `PR #${obs.pr.number}がdevelopへマージ済み`);
      return mk(
        "attention",
        "要確認",
        obs.pr.integration === false
          ? `PR #${obs.pr.number}は統合ブランチ（develop）以外へマージされています。developに成果がないため完了とは扱いません`
          : `PR #${obs.pr.number}のマージ先が統合ブランチか確認できません。完了とは扱いません`,
        "user",
      );
    }

    if (ci.launchState === "LAUNCH_FAILED") {
      return mk("attention", "起動失敗", ci.lastError ?? "起動できませんでした", "retry");
    }
    if (ci.launchState === "LAUNCHING") return mk("launching", "起動の受付中", "ジョブを積んでいます");
    if (ci.launchState === "LAUNCHED") {
      if (obs.jobStatus && TERMINAL_JOB_STATUSES.includes(obs.jobStatus)) {
        return mk("attention", "起動失敗", `起動ジョブが${obs.jobStatus}で終わりました`, "retry");
      }
      if (obs.needsUser) return mk("attention", "本人操作待ち", "このIssueで本人の確認・操作が必要です", "user");
      const queued = obs.jobStatus && ACTIVE_JOB_STATUSES.includes(obs.jobStatus) && !obs.sessionAlive;
      if (queued) return mk("running", "起動待ち", "ジョブを積みました。ホストが受け取り次第、起動します");
      if (obs.sessionAlive) return mk("running", "実行中", prNumber ? `PR #${prNumber}を作成済み。マージ待ち` : "セッションが実行中です");
      if (prNumber) return mk("running", "マージ待ち", `PR #${prNumber}を作成済み。マージを待っています`);
      return mk("attention", "要確認", "セッションが終了しましたが、PRもクローズもありません", "retry");
    }

    // 未起動: 依存を評価する
    if (trail.has(key)) return mk("attention", "循環", "依存が循環しています");
    trail.add(key);
    const dependencies: ChildDisplay["dependencies"] = [];
    const waiting: string[] = [];
    const human: string[] = [];
    const blockedBy: string[] = [];
    for (const dep of ci.child.dependsOn) {
      const depKey = refKey(dep);
      const depChild = byKey.get(depKey);
      const depEval = depChild ? evaluate(depKey, trail) : null;
      const results = evaluateDependency(dep, obsOf(depKey), depChild?.verifiedAt ?? null, depChild?.child);
      dependencies.push({ ref: depKey, conditions: results });
      const decision = decideDependencyWait(results);
      if (decision === "resume") continue;
      if (depEval && (depEval.display.phase === "attention" || depEval.display.phase === "skipped")) {
        blockedBy.push(`${formatRef(dep)}（${depEval.display.label}）`);
      } else if (decision === "needs_confirm") {
        const r = results.find((x) => x.satisfied === null);
        human.push(`${formatRef(dep)}: ${r?.detail ?? "人の確認が必要です"}`);
      } else {
        const r = results.find((x) => x.satisfied === false);
        waiting.push(`${formatRef(dep)}: ${r?.detail ?? "条件が未成立です"}`);
      }
    }
    trail.delete(key);
    if (blockedBy.length > 0) return mk("blocked", "停止（前提の問題）", `${blockedBy.join("、")}の対応が済むまで進めません`, null, dependencies);
    if (human.length > 0) return mk("attention", "人の確認待ち", human.join(" / "), "verify", dependencies);
    if (waiting.length > 0) return mk("waiting", "待機（前提）", waiting.join(" / "), null, dependencies);
    return mk("ready", "起動待ち", "着手条件が成立しています", null, dependencies);
  };

  const ordered = input.children.map((c) => evaluate(refKey(c.child), new Set()));

  const counts = { done: 0, running: 0, waiting: 0, attention: 0, total: ordered.length };
  for (const e of ordered) {
    const p = e.display.phase;
    if (p === "done") counts.done++;
    else if (p === "running" || p === "launching") counts.running++;
    else if (p === "attention") counts.attention++;
    else counts.waiting++;
  }

  const active = counts.running;
  const slots = Math.max(0, input.maxParallel - active);
  const ready = ordered.filter((e) => e.display.phase === "ready" && e.launchState === "PENDING");
  const toLaunch = input.status === "RUNNING" ? ready.slice(0, slots).map((e) => refKey(e.child)) : [];
  const nextCandidate = ready[0] ?? ordered.find((e) => e.display.phase === "waiting");
  const next = nextCandidate ? refKey(nextCandidate.child) : null;

  const evidence: CompletionEvidence[] = [];
  // リリースと無関係な子（independent）と、PRを持たない環境設定・確認の作業（#4523）は、
  // 「PRのdevelopマージ／main反映」では数えない。後者は別項目（作業の検証）で確かめる
  const isCodeWork = (e: ChildEvaluation) => e.child.timing !== "independent" && !isTimedNonCodeWork(e.child, obsOf(refKey(e.child)));
  const codeChildren = ordered.filter(isCodeWork);
  const nonCodeChildren = ordered.filter((e) => e.child.timing !== "independent" && isTimedNonCodeWork(e.child, obsOf(refKey(e.child))));
  // 完了条件はIssueのクローズで代用しない。実装PRのdevelopマージを確かめられた子だけを数える
  const allDone =
    ordered.length > 0 &&
    ordered.every((e) => e.display.phase === "done") &&
    codeChildren.every((e) => isChildMerged(obsOf(refKey(e.child))));
  evidence.push({ label: "子のdevelopマージ", ok: allDone, detail: `${counts.done}/${counts.total}` });
  const unreleased = codeChildren.filter((e) => !isChildReleased(obsOf(refKey(e.child))));
  evidence.push({
    label: "本番（main）への反映",
    ok: allDone && unreleased.length === 0,
    detail: unreleased.length === 0 ? "全て反映済み" : `未反映: ${unreleased.map((e) => formatRef(e.child)).join(", ")}`,
  });
  if (nonCodeChildren.length > 0) {
    // マージ・リリースに成功しても、環境設定・本番確認などの作業が残れば親は完了にしない
    const unverified = nonCodeChildren.filter((e) => !isNonCodeWorkVerified(obsOf(refKey(e.child)), e.verifiedAt));
    evidence.push({
      label: "リリース前後の作業の検証",
      ok: unverified.length === 0,
      detail:
        unverified.length === 0
          ? "全て検証済み"
          : `残り: ${unverified.map((e) => `${formatRef(e.child)}（${e.child.timing === "pre-release" ? "リリース前" : "リリース後"}）`).join(", ")}`,
    });
  }
  evidence.push({
    label: "本番確認",
    ok: input.parentVerifiedAt !== null,
    detail: input.parentVerifiedAt ? "確認済み" : "未確認（人が記録します）",
  });
  const complete = evidence.every((e) => e.ok);

  return { children: ordered, counts, toLaunch, next, completion: { complete, evidence } };
}

/**
 * 巡回の観測に使うIssue全体。**計画の子と、その依存先だけ**（計画外へは広げない）。
 * 開始時の版で固定した対象のみを見るため、後から本文・子一覧が変わっても増えない。
 */
export function collectObservedRefs(plan: PlanSnapshot): { repository: string; number: number }[] {
  const seen = new Map<string, { repository: string; number: number }>();
  for (const child of plan.children) {
    seen.set(refKey(child), { repository: child.repository, number: child.number });
    for (const dep of child.dependsOn) seen.set(refKey(dep), { repository: dep.repository, number: dep.number });
  }
  return [...seen.values()];
}
