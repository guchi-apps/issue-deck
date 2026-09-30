import { db } from "@/lib/db";
import { isPlanReviewCommentBody } from "@/lib/dispatch/plan-review-auto-reflect";

/**
 * 計画レビュー（G1）の指摘コメントが届いたことを、そのレビューのジョブへ記録する（#3659）。
 *
 * **ジョブの`SUCCEEDED`はレビューのセッションが立った時点で、指摘の投稿はその数分後。**
 * Issue一覧はコメント本文を持たないため、「作成中」の終わりを`finishedAt`からの猶予
 * （`isPlanReviewJobCreating`）でしか知れず、指摘が届いた後も数分間「計画レビュー作成中」の
 * ままになっていた。ここで`reviewPostedAt`を埋めると、一覧・通知の保留もIssue詳細と同じ時点で
 * 「作成中」を終える。
 *
 * 記録する先は、**コメントより前に積まれた最新の`SUCCEEDED`のジョブ**に限る。計画を出し直した
 * 直後に次のレビューが積まれていても、前回のレビューが遅れて届いた指摘で次のジョブを
 * 「届いた」ことにしない。
 *
 * @returns 記録したらtrue
 */
export async function markPlanReviewPosted(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBody: string;
  commentCreatedAt: Date;
}): Promise<boolean> {
  if (!isPlanReviewCommentBody(params.commentBody)) return false;
  const job = await db.dispatchJob.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      kind: "PLAN_REVIEW",
      status: "SUCCEEDED",
      createdAt: { lte: params.commentCreatedAt },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, reviewPostedAt: true },
  });
  if (!job || job.reviewPostedAt !== null) return false;
  await db.dispatchJob.update({
    where: { id: job.id },
    data: { reviewPostedAt: params.commentCreatedAt },
  });
  return true;
}
