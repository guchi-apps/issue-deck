/**
 * リリース候補の失敗から「リリース完了まで進める」系列（#4480）の判断。**純関数だけ**を置き、
 * GitHub・DB・dispatchへの操作は`release-completion-run.ts`が持つ。
 *
 * 世代ごとの修正（Issue→修正PR→developへ取り込み→候補の作り直し→再検証）は既存の修正系列
 * （`ReleaseFixSeries`・`runReleaseFixSweep`）が進める。ここが足すのは、その間をつなぐ操作だけ:
 *
 * - 修正Issueの起動（「修正を開始」を押さなくてよい）
 * - 再検証で残った指摘・失敗から、次の世代の修正を起案する（同じ修正Issueへ戻す既存の流れ）
 * - 修正系列が作り直した後継の候補へ追従する（系列の外で作り直された候補は追わない）
 * - 開始者が本番まで許可した系列だけ、記録した候補1本を本番mainへマージする
 * - マージ後のdeploy追跡と稼働SHAの確認（#4007の`decideDeployRecoveryRelease`を使う）
 *
 * **本番マージの権限はこの系列の記録（開始者・範囲・期限・停止・候補のSHA）だけで判定する。**
 * ラベル・PR本文・PRの作者は権限にしない（公開リポジトリでは誰でも書けるため）。
 */

import { isLegacyGenerationLimitStopReason, isReverifyFailureReason, NOTHING_TO_ADD_REASON } from "@/lib/release-fix-series";
import { isReleaseCandidateHeadRef } from "@/lib/release-branch";
import { REVIEW_OPEN_ITEM_LABEL, type ReviewEvidenceStage } from "@/lib/release-review-reevaluation";

export const RELEASE_COMPLETION_SCOPE_READY = "until_ready";
export const RELEASE_COMPLETION_SCOPE_PRODUCTION = "until_production";
export const RELEASE_COMPLETION_SCOPES = [RELEASE_COMPLETION_SCOPE_READY, RELEASE_COMPLETION_SCOPE_PRODUCTION] as const;
export type ReleaseCompletionScope = (typeof RELEASE_COMPLETION_SCOPES)[number];

export function parseReleaseCompletionScope(value: unknown): ReleaseCompletionScope | null {
  return (RELEASE_COMPLETION_SCOPES as readonly unknown[]).includes(value) ? (value as ReleaseCompletionScope) : null;
}

/** 開始から期限までの時間。承認はこの期間だけ有効で、延ばさない */
export const RELEASE_COMPLETION_TTL_MS = 24 * 60 * 60 * 1000;
/** 修正Issueのセッションで使ってよい額（API換算の目安。`SessionUsage.costUsd`の合計） */
export const RELEASE_COMPLETION_COST_LIMIT_USD = 30;
/** 修正Issueを起動してから、修正PRが現れるまで待つ時間。過ぎたら止めて人へ渡す */
export const RELEASE_COMPLETION_FIX_START_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export const RELEASE_COMPLETION_STATUSES = [
  "investigating",
  "fixing",
  "awaiting_decision",
  "checking",
  "awaiting_approval",
  "merging",
  "releasing",
  "verifying",
  "deploy_recovery",
  "completed",
  "needs_attention",
  "stopped",
] as const;
export type ReleaseCompletionStatus = (typeof RELEASE_COMPLETION_STATUSES)[number];

const TERMINAL: ReadonlySet<string> = new Set(["completed", "needs_attention", "stopped"]);

export function isReleaseCompletionActive(status: string): boolean {
  return !TERMINAL.has(status);
}

export type ReleaseCompletionStopReason =
  | "timed_out"
  | "stopped_by_user"
  | "cost_limit"
  | "scope_not_allowed"
  | "candidate_closed"
  | "candidate_changed"
  | "base_changed"
  | "checks_unavailable"
  | "execution_failure"
  | "setup_missing"
  | "fix_blocked"
  | "fix_stopped"
  | "fix_not_started"
  | "dispatch_failed"
  | "ci_failed"
  | "blocked_by_label"
  | "merge_failed"
  | "deploy_not_started"
  | "deploy_failed"
  | "deploy_cancelled"
  | "version_unverified"
  | "release_timed_out"
  | "deploy_recovery_busy"
  | "deploy_recovery_failed"
  // 公開承認（#4666）から始めた系列だけの停止理由
  | "approval_invalidated"
  | "approval_revoked"
  | "approval_checks_failed"
  | "approval_review_undecided"
  | "finalize_failed"
  // 指摘0件で未確認範囲だけが残り、統合検証を踏まえた再評価でも解消しなかった（#4768。実行障害ではない）
  | "review_unverified";

/**
 * 公開承認から始めた系列で、停止しても**承認を失効させない**理由（同じ処理の再試行で再承認を増やさない。#4666）。
 * 対象の変化（候補の更新・置換・mainの前進・取消・期限切れ）と利用者の取消は、承認ごと終える
 */
export const APPROVAL_RETRYABLE_STOP_REASONS: ReadonlySet<ReleaseCompletionStopReason> = new Set<ReleaseCompletionStopReason>([
  "checks_unavailable",
  "execution_failure",
  "setup_missing",
  "ci_failed",
  "blocked_by_label",
  "merge_failed",
  "approval_checks_failed",
  "approval_review_undecided",
  "finalize_failed",
  "cost_limit",
  "review_unverified",
]);

/** 修正系列の1世代（候補に紐づく最新のもの）を、判断に要る範囲だけ写したもの */
export type CompletionSeriesSnapshot = {
  id: string;
  /** `ReleaseFixStatus` */
  status: string;
  issueNumber: number;
  fixPrNumber: number | null;
  stopReason: string | null;
  successorPrNumber: number | null;
  successorHeadSha: string | null;
  successorBaseSha: string | null;
  /** 修正Issueの実行の状況（`readReleaseFixStartState`） */
  startState: "none" | "queued" | "running";
};

export type CompletionCheckState = "passed" | "failed" | "needs_check" | "pending" | "not_applicable" | "not_run" | "invalidated";

export type CompletionChecks = {
  aiReview: CompletionCheckState;
  integration: CompletionCheckState;
  /** Mac検証。`passed`・`not_applicable`（設定が無いリポジトリ）以外は合格にしない */
  mac: "passed" | "failed" | "pending" | "not_applicable" | "needs_setup" | "not_recorded" | "invalidated";
  /** 全体レビューの指摘の件数（起案に使う） */
  findingCount: number;
  /** 統合検証の失敗が実行障害（環境）か（`classifyIntegrationFailure`） */
  integrationFailureKind: "execution" | "code" | "unknown" | null;
  /** 統合検証の失敗が設定不足か */
  integrationSetupGap: boolean;
  /**
   * 全体レビューの要確認が、止める指摘だけを原因とし、その全件にユーザーの有効な非修正の判断がある（#4657）。
   * このときは全体レビューを「直すべき問題」として扱わない（新たな修正を起案しない）。省略時はfalse
   */
  aiReviewClearedByDecision?: boolean;
  /**
   * 指摘0件で未確認範囲だけが残った全体レビュー（`needs_check`）の段階（#4768。`toCompletionChecks`が
   * `describeReviewEvidenceStage`から作る）。`reevaluating`は統合検証の完了を受けた再評価がまだ済んでいない、
   * `settled`は再評価済み・または再評価しても変わらない（証跡に依存しない未確認）。`detail`は止めるときに示す内容。
   * 省略時は`settled`として扱う
   */
  aiReviewUnverified?: { stage: "reevaluating" | "settled"; detail: string | null } | null;
};

/**
 * マージゲートの要確認が、ユーザーの判断で解除できるものだけか（#4657）。**全体レビューの要確認（止める指摘）だけ**が
 * 対象で、統合検証の要確認・未確認範囲・実行中・失敗・古い結果は判断では解除しない。ゲート自体の状態は書き換えない
 */
export function isGateClearedByReviewDecisions(input: {
  gateStatus: "ready" | "needs_confirmation" | "blocked" | "not_enforced";
  blockers: readonly { kind: string; state: string }[];
  aiReviewCleared: boolean;
}): boolean {
  return (
    input.gateStatus === "needs_confirmation" &&
    input.aiReviewCleared &&
    input.blockers.length > 0 &&
    input.blockers.every((b) => b.kind === "ai_review" && b.state === "needs_check")
  );
}

export type CompletionCandidateObservation = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
};

export type ReleaseCompletionState = {
  status: ReleaseCompletionStatus;
  scope: string;
  startedByUserId: string;
  expiresAt: Date;
  stoppedAt: Date | null;
  candidatePrNumber: number;
  candidateHeadSha: string;
  candidateBaseSha: string;
  dispatchedSeriesId: string | null;
  dispatchedAt: Date | null;
  costLimitUsd: number;
  costUsedUsd: number;
  /**
   * 公開承認（#4666）から始めた系列か。承認由来の系列は修正Issueを起動・起案せず、検証の失敗・未判断の指摘は
   * 理由を示して止まる（公開承認は修正の実行指示ではない）。省略時はfalse
   */
  fromPublishApproval?: boolean;
};

/**
 * 公開準備（正式バンプ。#4496）の観測。新方式のリリース候補（`release-rc/<番号>`）のときだけ入る
 * （旧方式の候補はnullで、従来どおり公開準備を要求しない）
 */
export type CompletionFinalizationSnapshot = {
  /** 候補の段階（`awaiting_approval`＝公開準備が済み、最終検証に合格して本番承認待ち） */
  phase: string;
  /** 適用済みの最新の公開準備。バンプ前headからバンプ後headへの対応だけを持つ */
  applied: { preHeadSha: string; finalHeadSha: string; finalBaseSha: string } | null;
  /** 最新の公開準備の状態と失敗理由（公開承認の系列が「公開準備が失敗した」を止める理由として出す）。無ければnull */
  latest?: { status: string; failureReason: string | null } | null;
};

export type ReleaseCompletionObservation = {
  now: Date;
  /** 新方式の候補のときの公開準備。旧方式・取得できないときはnull */
  finalization?: CompletionFinalizationSnapshot | null;
  /** 追っている候補の現在。取得できなければnull（判断せず待つ） */
  candidate: CompletionCandidateObservation | null;
  /** 候補に紐づく最新の修正系列（起点か後継がこの候補）。無ければnull */
  series: CompletionSeriesSnapshot | null;
  /** 現在のbase・headに対する検証。取得できなければnull */
  checks: CompletionChecks | null;
};

export type ReleaseCompletionDecision =
  | { action: "wait"; status?: ReleaseCompletionStatus; note?: string | null }
  | { action: "dispatch_fix"; seriesId: string; issueNumber: number }
  | { action: "create_fix"; sourceKind: "review_finding" | "integration_failure" }
  | { action: "follow_successor"; prNumber: number; headSha: string; baseSha: string }
  | { action: "evaluate_merge" }
  /** 全体レビューの未確認範囲を、統合検証の結果で再評価する（#4768。積むのは`reevaluateReleaseReviewIfReady`） */
  | { action: "reevaluate_review" }
  | { action: "begin_release"; mergeSha: string }
  | { action: "stop"; reason: ReleaseCompletionStopReason; detail?: string };

const FIX_WORKING = new Set(["issue_created", "fix_in_progress"]);
const FIX_CHECKING = new Set(["fix_merged", "rebuilding", "reverifying"]);

/**
 * 候補の段階（本番マージ前）の1巡ぶんの判断。本番へ出したあと（`releasing`以降）は
 * `decideDeployRecoveryRelease`、引き継いだ本番復旧は引き継ぎ先の状態で決めるので、ここでは扱わない。
 *
 * 判断の順: 停止・期限・費用 → 候補のマージ・取消・置換 → 修正系列の進行 → 検証の結果。
 * **読めないものは合格にしない。** 候補や検証が取れなければ待つ（期限で止まる）。
 */
export function decideReleaseCompletion(
  run: ReleaseCompletionState,
  observation: ReleaseCompletionObservation,
): ReleaseCompletionDecision {
  if (run.stoppedAt !== null || run.status === "stopped") return { action: "wait" };
  if (!isReleaseCompletionActive(run.status)) return { action: "wait" };
  if (observation.now.getTime() >= run.expiresAt.getTime()) return { action: "stop", reason: "timed_out" };

  const candidate = observation.candidate;
  if (candidate === null) return { action: "wait" };
  if (candidate.number !== run.candidatePrNumber) return { action: "stop", reason: "candidate_changed" };

  // 公開準備のバンプで候補のheadが進んだ（#4496）。**記録したバンプ前headからバンプ後headへの更新だけ**を後継として追う
  // （修正系列の`successorHeadSha`と同形）。無関係なhead変更・別のバンプは従来どおり下で`candidate_changed`として止める
  const finalized = observation.finalization?.applied ?? null;
  if (
    finalized &&
    candidate.headSha !== run.candidateHeadSha &&
    candidate.headSha === finalized.finalHeadSha &&
    finalized.preHeadSha === run.candidateHeadSha
  ) {
    return { action: "follow_successor", prNumber: candidate.number, headSha: finalized.finalHeadSha, baseSha: finalized.finalBaseSha };
  }

  // 人（または系列）がこの候補をマージした。記録した内容のままなら本番反映の追跡へ進む
  if (candidate.merged) {
    if (candidate.headSha !== run.candidateHeadSha) return { action: "stop", reason: "candidate_changed", detail: candidate.headSha.slice(0, 7) };
    if (!candidate.mergeCommitSha) return { action: "wait" };
    return { action: "begin_release", mergeSha: candidate.mergeCommitSha };
  }

  const series = observation.series;
  // 修正系列の後継が、その後の公開準備のバンプで置き換わり、系列はもうバンプ後のheadを追っている（#4729）。
  // 系列の記録はバンプ前のrevisionのまま残るので、これを後継として戻すと上の分岐と巡回ごとに往復する
  const successorBumped =
    finalized !== null &&
    series !== null &&
    series.successorPrNumber === run.candidatePrNumber &&
    series.successorHeadSha === finalized.preHeadSha &&
    run.candidateHeadSha === finalized.finalHeadSha;
  // 修正系列が作り直した後継へ進む。作り直しで元の候補は閉じられるので、取消の判定より先に見る
  // 新方式の候補（#4495）は同じPRのrevisionが進むので、番号が同じでもheadが違えば後継として追う
  if (
    series &&
    !successorBumped &&
    series.successorPrNumber !== null &&
    series.successorHeadSha &&
    series.successorBaseSha &&
    (series.successorPrNumber !== run.candidatePrNumber || series.successorHeadSha !== run.candidateHeadSha)
  ) {
    return {
      action: "follow_successor",
      prNumber: series.successorPrNumber,
      headSha: series.successorHeadSha,
      baseSha: series.successorBaseSha,
    };
  }
  if (candidate.state === "closed") {
    // 作り直しの最中（後継の作成待ち）は待つ。それ以外の取消は系列の外の操作なので追わない
    if (series && series.status === "rebuilding") return { action: "wait", status: "checking" };
    return { action: "stop", reason: "candidate_closed" };
  }
  // 新方式の候補（#4495）は、修正系列の取り込みで同じPRのheadが進む。系列が新しいrevisionを後継として記録するまで待つ
  if (candidate.headSha !== run.candidateHeadSha && series && series.status === "rebuilding") return { action: "wait", status: "checking" };
  // 系列の外で候補が作り直された（同じ番号でHEADが動いた）。承認した内容と違うので追わない
  if (candidate.headSha !== run.candidateHeadSha) {
    return { action: "stop", reason: "candidate_changed", detail: candidate.headSha.slice(0, 7) };
  }

  // 費用の上限は、新しい作業（起動・起案・マージ）を始める前に効かせる
  const overBudget = run.costUsedUsd >= run.costLimitUsd;
  const approvalRun = run.fromPublishApproval === true;

  if (series && FIX_WORKING.has(series.status)) {
    // 公開承認の系列は修正Issueを起動しない（修正で候補が変われば承認は失効する）
    if (series.status === "issue_created" && series.startState === "none" && !approvalRun) {
      if (run.dispatchedSeriesId !== series.id) {
        if (overBudget) return { action: "stop", reason: "cost_limit" };
        return { action: "dispatch_fix", seriesId: series.id, issueNumber: series.issueNumber };
      }
      // 起動したのに修正PRが現れないまま、セッションも動いていない
      const waited = run.dispatchedAt ? observation.now.getTime() - run.dispatchedAt.getTime() : 0;
      if (waited >= RELEASE_COMPLETION_FIX_START_TIMEOUT_MS) return { action: "stop", reason: "fix_not_started", detail: `#${series.issueNumber}` };
    }
    return { action: "wait", status: "fixing", note: null };
  }
  if (series && series.status === "awaiting_decision") {
    // 内部確認の完了待ちは確認が済めば次の巡回で進み、無関係な変更の判断は人が「含めて反映」を押せば進む
    return { action: "wait", status: "awaiting_decision", note: series.stopReason };
  }
  if (series && FIX_CHECKING.has(series.status)) return { action: "wait", status: "checking", note: null };
  if (series && series.status === "stopped" && series.stopReason) {
    // 再検証で指摘が残った停止は、下の検証結果から次の世代を起案する。それ以外（準備の失敗・PRが閉じられた等）は人へ
    if (series.stopReason === NOTHING_TO_ADD_REASON) {
      // 修正PRが候補に足せない（すでに含まれている可能性）。修正系列が再評価を続けるので、理由を示して待つ（#4422・#4452）
      return { action: "wait", status: "awaiting_decision", note: series.stopReason };
    }
    if (!isReverifyFailureReason(series.stopReason) && !isLegacyGenerationLimitStopReason(series.stopReason)) {
      return { action: "stop", reason: "fix_stopped", detail: series.stopReason };
    }
  }

  const checks = observation.checks;
  if (checks === null) return { action: "wait", status: "checking" };
  const states = [checks.aiReview, checks.integration];
  const problem = (s: CompletionCheckState) => s === "failed" || s === "needs_check";
  const clearedByDecision = checks.aiReview === "needs_check" && checks.aiReviewClearedByDecision === true;
  // 指摘0件で未確認範囲だけの要確認（#4768）。コードの指摘でも実行障害でもないので、修正の起案・「実行障害」の停止に
  // 回さず、統合検証の完了と再評価を待ってから判断する（下の`unverifiedOnly`の分岐）
  const unverifiedOnly = checks.aiReview === "needs_check" && checks.findingCount === 0 && !clearedByDecision;
  // 止める指摘の全件をユーザーが修正しないと判断した全体レビューは、直す対象として扱わない（#4657）
  const aiProblem = problem(checks.aiReview) && !clearedByDecision && !unverifiedOnly;
  if (aiProblem || problem(checks.integration)) {
    if (problem(checks.integration) && checks.integrationSetupGap) return { action: "stop", reason: "setup_missing" };
    if (approvalRun) {
      // 公開承認は修正の実行指示ではない。失敗・未判断の指摘は理由を示して止め、採否は#4657の判断で解除する
      if (!problem(checks.integration) && checks.aiReview === "needs_check" && checks.findingCount > 0) {
        return { action: "stop", reason: "approval_review_undecided", detail: `${checks.findingCount}件` };
      }
      const failed = [aiProblem ? "全体レビュー" : null, problem(checks.integration) ? "統合検証" : null].filter(Boolean).join("・");
      return { action: "stop", reason: "approval_checks_failed", detail: failed };
    }
    if (problem(checks.integration) && !aiProblem && checks.integrationFailureKind === "execution") {
      return { action: "stop", reason: "execution_failure" };
    }
    if (overBudget) return { action: "stop", reason: "cost_limit" };
    // 全体レビューの指摘があればそれを、無ければ統合検証の失敗を起案する
    const sourceKind = aiProblem && checks.findingCount > 0 ? "review_finding" : "integration_failure";
    if (sourceKind === "integration_failure" && !problem(checks.integration)) {
      // 全体レビューが失敗だが指摘が無い（実行障害）。コードの指摘ではないので起案しない
      return { action: "stop", reason: "execution_failure" };
    }
    return { action: "create_fix", sourceKind };
  }
  if (checks.mac === "failed" || checks.mac === "needs_setup") return { action: "stop", reason: "setup_missing", detail: "Mac検証" };
  if (unverifiedOnly) {
    // 統合検証が終わっていなければ待つ（終われば証跡に依存する未確認は再評価で解消し得る）
    if (checks.integration === "pending" || checks.integration === "not_run" || checks.integration === "invalidated") {
      return { action: "wait", status: "checking", note: UNVERIFIED_WAIT_INTEGRATION_NOTE };
    }
    if (checks.aiReviewUnverified?.stage === "reevaluating") return { action: "reevaluate_review" };
    // 再評価でも残った（または再評価で変わらない）。理由を示して止める（実行障害ではない）
    return { action: "stop", reason: "review_unverified", detail: checks.aiReviewUnverified?.detail ?? undefined };
  }
  if (states.some((s) => s === "pending" || s === "not_run" || s === "invalidated") || !["passed", "not_applicable"].includes(checks.mac)) {
    return { action: "wait", status: "checking" };
  }

  // 現在のbase・headで全部合格した。**新方式の候補は、正式バンプ（公開準備）と最終検証が済むまで公開へ進めない**。
  // 公開準備を始めるのは人の操作で、この系列は代わりに押さない（起案は本番公開の実行指示ではない）
  if (observation.finalization && !isFinalizationReady(observation.finalization, candidate.headSha)) {
    if (approvalRun) {
      // 公開準備が失敗して修正工程へ戻った（期限切れ・workflowの失敗・最終検証の失敗）。理由を示して止める
      const latest = observation.finalization.latest ?? null;
      if (observation.finalization.phase === "review" && latest && (latest.status === "failed" || latest.status === "expired" || latest.status === "superseded")) {
        return { action: "stop", reason: "finalize_failed", detail: latest.failureReason ?? undefined };
      }
      return { action: "wait", status: "checking", note: "公開承認済み。正式バンプと最終検証（バンプ後のCI・再検証）を待っています" };
    }
    return { action: "wait", status: "awaiting_approval", note: "公開準備（正式バンプと最終検証）の完了を待っています" };
  }
  if (run.scope !== RELEASE_COMPLETION_SCOPE_PRODUCTION) return { action: "wait", status: "awaiting_approval" };
  if (overBudget) return { action: "stop", reason: "cost_limit" };
  return { action: "evaluate_merge" };
}

/**
 * 全体レビューが指摘0件で未確認範囲だけの要確認か、その段階と止めるときに示す内容（#4768）。
 * 該当しなければnull。段階は`describeReviewEvidenceStage`（画面のバッジと同じ規則）から読む
 */
export function describeUnverifiedReview(input: {
  /** 表示上の状態（未確認範囲つきの`passed`は`needs_check`へ読み替え済み） */
  state: string;
  findingCount: number;
  stage: ReviewEvidenceStage | null | undefined;
  unverifiedScope: string | null | undefined;
}): CompletionChecks["aiReviewUnverified"] {
  if (input.state !== "needs_check" || input.findingCount > 0) return null;
  const kind = input.stage?.kind;
  const items = input.stage?.kind === "needs_check" ? input.stage.items.map((k) => REVIEW_OPEN_ITEM_LABEL[k]) : [];
  const scope = (input.unverifiedScope ?? "").trim();
  const parts = [items.length > 0 ? items.join("・") : null, scope ? (scope.length > 200 ? `${scope.slice(0, 200)}…` : scope) : null].filter(
    (v): v is string => v !== null,
  );
  return {
    stage: kind === "reevaluating" || kind === "integration_waiting" ? "reevaluating" : "settled",
    detail: parts.length > 0 ? parts.join("：") : null,
  };
}

export const UNVERIFIED_WAIT_INTEGRATION_NOTE = "統合検証の完了を待って、全体レビューの未確認範囲を再評価します";
export const UNVERIFIED_REEVALUATING_NOTE = "統合検証の結果で、全体レビューの未確認範囲を再評価しています";

/**
 * 再評価を積もうとした結果（`reevaluateReleaseReviewIfReady`）で、待ち続けてよいか（#4768）。積めた・実行中・
 * 実行ホストが空いていない（一時的）なら待つ。それ以外（再評価の対象外・積める状態でない）は、待っても変わらないので止める
 */
export function reevaluationKeepsWaiting(outcome: { action: string; reason?: string }): boolean {
  if (outcome.action === "rerun") return true;
  if (outcome.action === "none") return outcome.reason === "review_active" || outcome.reason === "review_in_progress";
  if (outcome.action === "skipped") return outcome.reason === "no_host";
  return false;
}

/** 公開準備が済んだ候補か。バンプ後のheadと一致し、段階が本番承認待ち（最終検証に合格済み）のときだけ */
export function isFinalizationReady(finalization: CompletionFinalizationSnapshot, headSha: string): boolean {
  return finalization.phase === "awaiting_approval" && finalization.applied !== null && finalization.applied.finalHeadSha === headSha;
}

export type CompletionMergeObservation = {
  now: Date;
  /** 新方式の候補のときの公開準備。旧方式はnull（公開準備を要求しない） */
  finalization?: CompletionFinalizationSnapshot | null;
  /** マージ直前にGitHubから取り直した候補 */
  pullRequest: {
    number: number;
    state: "open" | "closed";
    merged: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    baseSha: string;
    mergeable: boolean | null;
    labels: readonly string[];
  } | null;
  mainSha: string | null;
  /** `evaluateReleaseMergeGate`を強制ありで評価した結果 */
  gateStatus: "ready" | "needs_confirmation" | "blocked";
  gateReasons: readonly string[];
  /** 要確認がユーザーの判断で解除できるものだけか（`isGateClearedByReviewDecisions`）。省略時はfalse */
  gateClearedByDecision?: boolean;
  /** Mac検証が合格（または対象外）か */
  macOk: boolean;
  ciState: "pending" | "success" | "failure" | "unknown";
  /**
   * 公開承認から始めた系列のとき、その承認が今も有効（`active`かつ範囲内）か（#4666）。承認由来でない系列は省略する。
   * 承認が失効・取消されていればマージしない
   */
  publishApprovalValid?: boolean;
};

/** 自動マージしないラベル（人がマージ前に見るための既存の合図） */
export const RELEASE_COMPLETION_BLOCKING_LABELS = ["22.merge-confirm-required", "00.check-user"] as const;

export type CompletionMergeDecision =
  | { action: "wait"; reason: string }
  | { action: "stop"; reason: ReleaseCompletionStopReason; detail?: string }
  | { action: "merge"; expectedHeadSha: string };

/**
 * 本番mainへの自動マージの可否。**権限の検査（範囲・開始者・期限・停止・費用）を先に、候補の検査を後に**行い、
 * どれか1つでも外れれば`merge`を返さない。`wait`はまだ判定できないだけで、権限は与えない。
 *
 * 要確認（`needs_confirmation`）も通さない。画面の明示確認で通せるのは人だけで、自動では検査を省かない。
 * 唯一の例外は、要確認が全体レビューの止める指摘だけで、その全件をユーザーが修正しないと判断した場合（#4657）。
 * 判断はユーザーの明示操作で、開始者が本番まで進めると選んだ系列にだけ効く。統合検証・Mac・CIの条件は変えない。
 */
export function decideCompletionMerge(
  run: Pick<
    ReleaseCompletionState,
    "status" | "scope" | "startedByUserId" | "expiresAt" | "stoppedAt" | "candidatePrNumber" | "candidateHeadSha" | "candidateBaseSha" | "costLimitUsd" | "costUsedUsd"
  >,
  observation: CompletionMergeObservation,
): CompletionMergeDecision {
  if (run.stoppedAt !== null || run.status === "stopped") return { action: "stop", reason: "stopped_by_user" };
  if (!run.startedByUserId || run.scope !== RELEASE_COMPLETION_SCOPE_PRODUCTION) return { action: "stop", reason: "scope_not_allowed" };
  if (observation.now.getTime() >= run.expiresAt.getTime()) return { action: "stop", reason: "timed_out" };
  if (run.costUsedUsd >= run.costLimitUsd) return { action: "stop", reason: "cost_limit" };
  if (observation.publishApprovalValid === false) return { action: "stop", reason: "approval_invalidated" };

  const pull = observation.pullRequest;
  if (pull === null) return { action: "wait", reason: "pull_request_unobserved" };
  if (pull.number !== run.candidatePrNumber || pull.baseRef !== "main" || !isReleaseCandidateHeadRef(pull.headRef)) {
    return { action: "stop", reason: "candidate_changed" };
  }
  if (pull.merged) return { action: "wait", reason: "already_merged" };
  if (pull.state === "closed") return { action: "stop", reason: "candidate_closed" };
  if (pull.headSha !== run.candidateHeadSha) return { action: "stop", reason: "candidate_changed", detail: pull.headSha.slice(0, 7) };
  if (observation.mainSha === null) return { action: "wait", reason: "main_unobserved" };
  // mainが進んだら、検証した前提（base）が変わっている。無関係なリリースの先行も含めて自動では進めない
  if (observation.mainSha !== run.candidateBaseSha || pull.baseSha !== run.candidateBaseSha) {
    return { action: "stop", reason: "base_changed", detail: `${run.candidateBaseSha.slice(0, 7)} → ${observation.mainSha.slice(0, 7)}` };
  }
  const blocking = pull.labels.filter((label) => (RELEASE_COMPLETION_BLOCKING_LABELS as readonly string[]).includes(label));
  if (blocking.length > 0) return { action: "stop", reason: "blocked_by_label", detail: blocking.join(", ") };

  // 新方式の候補は、正式バンプ後のheadで最終検証に合格している（公開準備が済んでいる）ことが前提。
  // バンプ差分だけで合格・ブランチ保護を迂回しない
  if (observation.finalization && !isFinalizationReady(observation.finalization, pull.headSha)) {
    return { action: "wait", reason: "finalization_not_ready" };
  }
  const gateOk = observation.gateStatus === "ready" || (observation.gateStatus === "needs_confirmation" && observation.gateClearedByDecision === true);
  if (!gateOk || !observation.macOk) {
    return { action: "wait", reason: observation.gateReasons.join(" / ") || "verification" };
  }
  if (observation.ciState === "failure") return { action: "stop", reason: "ci_failed" };
  if (observation.ciState !== "success") return { action: "wait", reason: `ci_${observation.ciState}` };
  if (pull.mergeable === false) return { action: "stop", reason: "base_changed", detail: "コンフリクトしています" };
  if (pull.mergeable === null) return { action: "wait", reason: "mergeable_unknown" };
  return { action: "merge", expectedHeadSha: run.candidateHeadSha };
}

/** 画面の6段階（#4451と同じ）。`index`は進行の位置（0〜5）、止まっているときは-1 */
export const RELEASE_COMPLETION_STAGES = [
  "原因を調査中",
  "修正とレビュー中",
  "修正後のチェック中",
  "本番へ反映中",
  "稼働確認中",
  "完了",
] as const;

export function releaseCompletionStageIndex(status: string, deployRecoveryStageIndex: number | null = null): number {
  switch (status) {
    case "investigating":
      return 0;
    case "fixing":
    case "awaiting_decision":
      return 1;
    case "checking":
    case "awaiting_approval":
    case "merging":
      return 2;
    case "releasing":
      return 3;
    case "verifying":
      return 4;
    case "completed":
      return 5;
    case "deploy_recovery":
      // 引き継いだ本番復旧の段階（調査・修正中は「本番へ反映中」の内側として扱う）
      return deployRecoveryStageIndex === null || deployRecoveryStageIndex < 3 ? 3 : deployRecoveryStageIndex;
    default:
      return -1;
  }
}

export function releaseCompletionStatusLabel(status: string, fromPublishApproval = false): string {
  // 公開承認の系列のチェックは、正式バンプ後の最終検証（修正後のチェックではない）
  if (fromPublishApproval && status === "checking") return "最終検証中";
  if (fromPublishApproval && status === "merging") return "自動公開待ち";
  switch (status) {
    case "investigating":
      return "原因を調査中";
    case "fixing":
      return "修正とレビュー中";
    case "awaiting_decision":
      return "判断待ち";
    case "checking":
      return "修正後のチェック中";
    case "awaiting_approval":
      return "本番承認待ち";
    case "merging":
      return "本番マージの確認中";
    case "releasing":
      return "本番へ反映中";
    case "verifying":
      return "稼働確認中";
    case "deploy_recovery":
      return "デプロイ失敗から復旧中";
    case "completed":
      return "完了";
    case "stopped":
      return "停止済み";
    default:
      return "操作が必要";
  }
}

/** 人の操作が要る状態か（画面の「操作が必要です」） */
export function releaseCompletionNeedsAction(status: string): boolean {
  return status === "needs_attention" || status === "awaiting_approval" || status === "awaiting_decision";
}

export function releaseCompletionStopMessage(reason: string | null, detail: string | null): string | null {
  const suffix = detail ? `（${detail}）` : "";
  switch (reason) {
    case null:
      return null;
    case "timed_out":
      return "期限（開始から24時間）を過ぎたため止めました。続けるには、改めて開始してください。";
    case "stopped_by_user":
      return "停止しました。新しい起動・起案・マージは行いません（すでに動いている実装セッションは止まりません）。";
    case "cost_limit":
      return "費用の上限に達したため、新しい作業を始めずに止めました。原因を確かめてから改めて開始してください。";
    case "scope_not_allowed":
      return "本番へのマージは許可されていません。";
    case "candidate_closed":
      return "リリース候補が系列の外で取り消されました。誤った候補へは進めません。";
    case "candidate_changed":
      return `リリース候補が系列の外で作り直された、または変更されました${suffix}。承認した内容と違うため、自動では進めません。`;
    case "base_changed":
      return `mainが進んだため${suffix}、検証済みの候補を自動で本番へマージしませんでした。候補を作り直してください。作り直した候補では検証をやり直します。`;
    case "checks_unavailable":
      return "検証の状態を取得できません。問題なしとは扱いません。";
    case "execution_failure":
      return "検証が実行障害（環境）で失敗した可能性があります。コードの不具合と断定できないため修正Issueは作りません。環境を確かめて再実行してください。";
    case "setup_missing":
      return `検証の設定が不足しています${suffix}。設定を整えてから再実行してください。`;
    case "fix_blocked":
      return `次の修正を起案できません${suffix}。`;
    case "fix_stopped":
      return `修正の工程が止まりました${suffix}。`;
    case "fix_not_started":
      return `修正Issue${detail ?? ""}を起動しましたが、修正PRが現れないまま時間が過ぎました。セッションの様子を確かめてください。`;
    case "dispatch_failed":
      return `修正Issueの実装を起動できませんでした${suffix}。`;
    case "ci_failed":
      return "リリース候補の現在のHEADでCIが失敗しました。本番へはマージしません。";
    case "blocked_by_label":
      return `リリース候補に人の確認を求めるラベルが付いているため、本番へ自動ではマージしません${suffix}。`;
    case "merge_failed":
      return `本番へのマージに失敗しました${suffix}。`;
    case "deploy_not_started":
      return "マージしたコミットのデプロイが始まらないまま時間が過ぎました。Actionsを確かめてください。";
    case "deploy_failed":
      return `本番デプロイが失敗しました${suffix}。`;
    case "deploy_cancelled":
      return `本番デプロイが取り消されたまま、再実行されませんでした${suffix}。`;
    case "version_unverified":
      return `デプロイは成功しましたが、対象の版が稼働していることを確かめられませんでした${suffix}。完了とは扱いません。`;
    case "release_timed_out":
      return "本番反映から稼働確認までの上限時間を過ぎました。";
    case "deploy_recovery_busy":
      return "デプロイの失敗を引き継ごうとしましたが、このリポジトリでは別の本番復旧が進行中です。";
    case "deploy_recovery_failed":
      return `デプロイの失敗から引き継いだ本番復旧が止まりました${suffix}。`;
    case "approval_invalidated":
      return `公開承認が失効したため、自動公開を止めました${suffix}。承認した内容から変わっています。内容を確かめて、改めて公開を承認してください。`;
    case "approval_revoked":
      return "自動公開を取り消しました。本番へはマージしません。";
    case "approval_checks_failed":
      return `最終検証で失敗・指摘が出たため、自動公開を止めました${suffix}。公開承認は修正の実行指示ではないため、修正Issueは作りません。修正するか再実行して合格したら、「自動公開を再開」で続けられます。`;
    case "approval_review_undecided":
      return `全体レビューに未判断の止める指摘が残っているため、自動公開を止めました${suffix}。指摘ごとに採否を判断するか修正してから、「自動公開を再開」で続けられます（公開承認は指摘の採否の判断として扱いません）。`;
    case "finalize_failed":
      return `公開準備（正式バンプ・最終検証）が失敗したため、自動公開を止めました${suffix}。同じ内容で公開準備をやり直すと、承認し直さずに続きます。`;
    case "review_unverified":
      return `全体レビューに止める指摘はありませんが、確認できなかった範囲が残ったため止めました${suffix}。統合検証の結果を踏まえた再評価でも解消していません。未確認の内容を確かめ、全体レビューを再実行するか、明示確認で進めてください。`;
    default:
      return reason;
  }
}

/** 同じ理由で本番マージを待ち続けて、画面に「長時間進んでいません」と出すまでの時間（#4725） */
export const RELEASE_COMPLETION_LONG_WAIT_MS = 15 * 60 * 1000;

/** `decideCompletionMerge`の`wait`の理由を、画面に出す日本語1行にする。未知の理由（検証ゲートの文言）はそのまま添える */
export function describeMergeWait(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "pull_request_unobserved":
      return "リリース候補のPRをGitHubから取得できていません";
    case "main_unobserved":
      return "本番mainの先端をGitHubから取得できていません";
    case "already_merged":
      return "マージ済みのPRを確認しています（本番反映の追跡へ進みます）";
    case "finalization_not_ready":
      return "公開準備（正式バンプと最終検証）がまだ完了していません";
    case "verification":
      return "検証（全体レビュー・統合検証・Mac検証）の条件がまだ満たされていません";
    case "ci_pending":
      return "CIの完了を待っています";
    case "ci_unknown":
      return "CIの結果を取得できていません";
    case "mergeable_unknown":
      return "GitHubのマージ可否を判定中";
    default:
      return `検証の条件を待っています: ${reason}`;
  }
}

/** 待ち理由の記録。理由が変わったとき（または初回）だけ待ち始めを更新し、同じ理由なら何も書かない */
export function nextMergeWait(
  prev: { reason: string | null; since: Date | null },
  reason: string,
  now: Date,
): { reason: string; since: Date } | null {
  if (prev.reason === reason && prev.since !== null) return null;
  return { reason, since: now };
}

/** 同じ理由で`RELEASE_COMPLETION_LONG_WAIT_MS`以上待っているか（境界を含む） */
export function isLongMergeWait(since: Date | null, now: Date): boolean {
  return since !== null && now.getTime() - since.getTime() >= RELEASE_COMPLETION_LONG_WAIT_MS;
}
