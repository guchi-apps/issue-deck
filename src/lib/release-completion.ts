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

import { isReverifyFailureReason, NOTHING_TO_ADD_REASON } from "@/lib/release-fix-series";
import { isReleaseCandidateHeadRef } from "@/lib/release-branch";

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
  | "deploy_recovery_failed";

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
};

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
};

export type ReleaseCompletionObservation = {
  now: Date;
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

  // 人（または系列）がこの候補をマージした。記録した内容のままなら本番反映の追跡へ進む
  if (candidate.merged) {
    if (candidate.headSha !== run.candidateHeadSha) return { action: "stop", reason: "candidate_changed", detail: candidate.headSha.slice(0, 7) };
    if (!candidate.mergeCommitSha) return { action: "wait" };
    return { action: "begin_release", mergeSha: candidate.mergeCommitSha };
  }

  const series = observation.series;
  // 修正系列が作り直した後継へ進む。作り直しで元の候補は閉じられるので、取消の判定より先に見る
  if (
    series &&
    series.successorPrNumber !== null &&
    series.successorPrNumber !== run.candidatePrNumber &&
    series.successorHeadSha &&
    series.successorBaseSha
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
  // 系列の外で候補が作り直された（同じ番号でHEADが動いた）。承認した内容と違うので追わない
  if (candidate.headSha !== run.candidateHeadSha) {
    return { action: "stop", reason: "candidate_changed", detail: candidate.headSha.slice(0, 7) };
  }

  // 費用の上限は、新しい作業（起動・起案・マージ）を始める前に効かせる
  const overBudget = run.costUsedUsd >= run.costLimitUsd;

  if (series && FIX_WORKING.has(series.status)) {
    if (series.status === "issue_created" && series.startState === "none") {
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
    if (!isReverifyFailureReason(series.stopReason)) {
      return { action: "stop", reason: "fix_stopped", detail: series.stopReason };
    }
  }

  const checks = observation.checks;
  if (checks === null) return { action: "wait", status: "checking" };
  const states = [checks.aiReview, checks.integration];
  const problem = (s: CompletionCheckState) => s === "failed" || s === "needs_check";
  if (problem(checks.aiReview) || problem(checks.integration)) {
    if (problem(checks.integration) && checks.integrationSetupGap) return { action: "stop", reason: "setup_missing" };
    if (problem(checks.integration) && !problem(checks.aiReview) && checks.integrationFailureKind === "execution") {
      return { action: "stop", reason: "execution_failure" };
    }
    if (overBudget) return { action: "stop", reason: "cost_limit" };
    // 全体レビューの指摘があればそれを、無ければ統合検証の失敗を起案する
    const sourceKind = problem(checks.aiReview) && checks.findingCount > 0 ? "review_finding" : "integration_failure";
    if (sourceKind === "integration_failure" && !problem(checks.integration)) {
      // 全体レビューが失敗だが指摘が無い（実行障害）。コードの指摘ではないので起案しない
      return { action: "stop", reason: "execution_failure" };
    }
    return { action: "create_fix", sourceKind };
  }
  if (checks.mac === "failed" || checks.mac === "needs_setup") return { action: "stop", reason: "setup_missing", detail: "Mac検証" };
  if (states.some((s) => s === "pending" || s === "not_run" || s === "invalidated") || !["passed", "not_applicable"].includes(checks.mac)) {
    return { action: "wait", status: "checking" };
  }

  // 現在のbase・headで全部合格した
  if (run.scope !== RELEASE_COMPLETION_SCOPE_PRODUCTION) return { action: "wait", status: "awaiting_approval" };
  if (overBudget) return { action: "stop", reason: "cost_limit" };
  return { action: "evaluate_merge" };
}

export type CompletionMergeObservation = {
  now: Date;
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
  /** Mac検証が合格（または対象外）か */
  macOk: boolean;
  ciState: "pending" | "success" | "failure" | "unknown";
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

  if (observation.gateStatus !== "ready" || !observation.macOk) {
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

export function releaseCompletionStatusLabel(status: string): string {
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
    default:
      return reason;
  }
}
