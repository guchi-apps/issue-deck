import { db } from "@/lib/db";

/**
 * 計画レビュー（G1）の種別と打ち止め（#3765）。
 *
 * 通常の自動運用は「初回レビュー1回 → 必要な計画修正 → 解消確認1回」まで。**種別はジョブの列に
 * 持たず、このIssueの`PLAN_REVIEW`ジョブの履歴から決める**（スキーマ・pollerを変えない）。
 * 人が画面から送った修正も、自動反映も、同じ「次の計画」として数えるので、**人の修正だけで全体レビューが
 * 初回へ戻ることは無い**。
 *
 * 数え方: 人が画面から積んだジョブ（`requestedByUserId`あり＝手動の追加レビュー）は新しい初回で、
 * そこから数え直す。自動で積んだジョブ（`requestedByUserId=null`）はその後ろへ続く。
 */

/** 解消確認を走らせるときにサーバーが残すコメントのマーカー。レビューのセッションが読む */
export const PLAN_REVIEW_KIND_RESOLVE_MARKER = "<!-- issue-deck:plan-review-kind:resolve -->";
/** 新しい初回レビュー（手動の追加レビュー含む）のマーカー。直前のresolveマーカーを打ち消す */
export const PLAN_REVIEW_KIND_INITIAL_MARKER = "<!-- issue-deck:plan-review-kind:initial -->";
/** 計画レビューを省略したことの記録 */
export const PLAN_REVIEW_SKIPPED_MARKER = "<!-- issue-deck:plan-review-skipped -->";
/** 解消確認を済ませたので、これ以上自動でレビューしないことの記録（人へ引き継ぐ） */
export const PLAN_REVIEW_LIMIT_MARKER = "<!-- issue-deck:plan-review-limit -->";
/** 解消確認の後も重大な問題が残ったことを、人へ知らせるコメントのマーカー */
export const PLAN_REVIEW_UNRESOLVED_MARKER = "<!-- issue-deck:plan-review-unresolved -->";

export type PlanReviewKind = "initial" | "resolve";

export type PlanReviewRound = { kind: PlanReviewKind | "stop"; ordinal: number };

type JobForRound = { id: string; createdAt: Date; requestedByUserId: string | null };

/**
 * 今のエポック（最新の手動レビュー以降）での、各ジョブの何回目か。**純関数**。
 * 戻り値は古い順のジョブidと序数（1始まり）。
 */
export function numberPlanReviewJobs(
  jobs: readonly JobForRound[],
): { id: string; ordinal: number }[] {
  const sorted = [...jobs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let epochStart = 0;
  sorted.forEach((job, index) => {
    if (job.requestedByUserId !== null) epochStart = index;
  });
  return sorted.slice(epochStart).map((job, index) => ({ id: job.id, ordinal: index + 1 }));
}

/**
 * 新しい計画が投稿されたときに積む次のレビューの種別。履歴が空なら初回、1件なら解消確認、
 * 2件以上なら`stop`（人へ引き継ぐ）。
 */
export function decideNextPlanReviewKind(jobs: readonly JobForRound[]): PlanReviewRound {
  const numbered = numberPlanReviewJobs(jobs);
  const ordinal = numbered.length + 1;
  if (ordinal === 1) return { kind: "initial", ordinal };
  if (ordinal === 2) return { kind: "resolve", ordinal };
  return { kind: "stop", ordinal };
}

/** このIssueの計画レビューのジョブ（積めて実行されたものだけ。拒否・失敗は数えない） */
export async function listCountedPlanReviewJobs(target: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<JobForRound[]> {
  return db.dispatchJob.findMany({
    where: { ...target, kind: "PLAN_REVIEW", status: { in: ["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, requestedByUserId: true },
  });
}

/** 届いたレビュー（ジョブ`jobId`）が、今のエポックで何回目か。見つからなければ1（旧ジョブは初回扱い） */
export async function planReviewOrdinalOf(
  target: { repositoryFullName: string; issueNumber: number },
  jobId: string,
): Promise<number> {
  const numbered = numberPlanReviewJobs(await listCountedPlanReviewJobs(target));
  return numbered.find((job) => job.id === jobId)?.ordinal ?? 1;
}

export function buildPlanReviewSkippedCommentBody(reason: string): string {
  return [
    `⏭️ **計画レビューを省略しました。** ${reason}`,
    "",
    "計画の承認は通常どおり人が行います。レビューが必要なら、Issue詳細の「計画をレビュー」から依頼できます。",
    "",
    PLAN_REVIEW_SKIPPED_MARKER,
  ].join("\n");
}

export function buildPlanReviewKindCommentBody(kind: PlanReviewKind, reason: string): string {
  const marker = kind === "resolve" ? PLAN_REVIEW_KIND_RESOLVE_MARKER : PLAN_REVIEW_KIND_INITIAL_MARKER;
  const title = kind === "resolve" ? "解消確認" : "初回レビュー";
  return [`🔎 **計画レビュー（${title}）を依頼しました。** ${reason}`, "", marker].join("\n");
}

export function buildPlanReviewLimitCommentBody(): string {
  return [
    "🛑 **計画レビューの自動実施はここまでです。** 初回レビューと解消確認の1回ずつを終えているため、自動で全体レビューを繰り返しません。",
    "",
    "必要なら、Issue詳細の「計画をレビュー」から追加のレビューを依頼できます（新しい初回レビューとして数えます）。",
    "",
    PLAN_REVIEW_LIMIT_MARKER,
  ].join("\n");
}
