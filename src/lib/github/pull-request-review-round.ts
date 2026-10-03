import type { AiReviewState } from "@/lib/github/check-rollup";
import type { PullRequestRepairRunSummary } from "@/lib/github/pull-request-repair-run";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";

/** PRを増やさずに進めるレビュー・修正サイクルの現在地。 */
export type PullRequestReviewRoundState =
  | "reviewing"
  | "changes-requested"
  | "needs-check"
  | "fixing"
  | "re-reviewing"
  | "approved"
  | "merge-pending";

export type PullRequestReviewRound = {
  state: PullRequestReviewRoundState;
  label: string;
  description: string;
};

/**
 * 既に取得済みのPR情報だけから、仕上げフェーズにおける詳細状態を決める。
 * レビュー修正は常に元PRのhead branchへ積むため、別Issueや後継PRを数えない。
 */
export function resolvePullRequestReviewRound(params: {
  reviewVerdict: PullRequestReviewVerdict | null;
  headSha: string | null;
  repairRun: PullRequestRepairRunSummary | null;
  reviewPending: boolean;
  aiReviewState: AiReviewState;
  autoMergeEnabled: boolean;
  readyToMerge: boolean;
}): PullRequestReviewRound {
  if (params.repairRun?.kind === "review") {
    return { state: "fixing", label: "修正中", description: "同じPRブランチへレビュー指摘を修正しています。" };
  }
  if (params.reviewPending) {
    return { state: "reviewing", label: "レビュー中", description: "このPRの最新コミットをレビューしています。" };
  }
  const verdict = params.reviewVerdict;
  const freshness = resolveReviewVerdictFreshness({ reviewedSha: verdict?.reviewedSha, headSha: params.headSha });
  if (verdict?.reviewKind === "changes-requested") {
    // 古い要修正判定だけでは「再レビューが実行中」とは判断しない。reviewPendingは上で
    // 実際のworkflow状態から処理済みなので、ここでは最新HEADに対する判定がまだ無いことを示す。
    if (freshness === "stale") {
      return { state: "changes-requested", label: "再レビュー待ち", description: "修正コミット後のレビュー結果がまだありません。必要なら再レビューを実行してください。" };
    }
    return { state: "changes-requested", label: "要修正", description: "指摘はこのPRで修正します。新しいIssueやPRは作成しません。" };
  }
  if (verdict?.reviewKind === "needs-check") {
    return {
      state: "needs-check",
      label: "確認待ち",
      description: "レビューは完了しています。内容を確認して次の対応を判断してください。",
    };
  }
  if (verdict?.reviewKind === "ok") {
    if (freshness === "stale") {
      return { state: "changes-requested", label: "再レビュー待ち", description: "最新コミットのレビュー結果がまだありません。再レビュー完了までレビューOKとして扱いません。" };
    }
    if (params.autoMergeEnabled || params.readyToMerge) {
      return { state: "merge-pending", label: "マージ待ち", description: "レビューOKです。既存のマージ手順へ進めます。" };
    }
    return { state: "approved", label: "レビューOK", description: "レビューで問題は見つかりませんでした。" };
  }
  if (params.aiReviewState === "failed") {
    return { state: "needs-check", label: "レビュー失敗", description: "自動レビューに失敗しました。実行ログを確認してください。" };
  }
  if (params.aiReviewState === "skipped") {
    return { state: "needs-check", label: "レビュー省略", description: "このPRでは自動レビューが省略されました。" };
  }
  if (params.aiReviewState === "none") {
    return { state: "needs-check", label: "レビュー未実行", description: "このPRでは自動レビューがまだ実行されていません。" };
  }
  return { state: "needs-check", label: "確認待ち", description: "レビューは完了しましたが判定結果を取得できませんでした。" };
}
