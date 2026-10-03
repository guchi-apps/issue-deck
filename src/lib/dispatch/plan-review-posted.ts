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
 * 記録する先は、**`reviewPostedAt`が未記入の`SUCCEEDED`ジョブのうち、コメントより前に積まれ、
 * 15分以内で最も古いもの**（#3648。#3659では「最新」だった）。「最新」だと、計画を出し直した後に
 * 前回のレビューが遅れて届いたとき、その指摘が**次の計画のジョブ**へ記録され、古い指摘で次の計画の
 * 保留が外れ、自動反映まで走る。古い順に割り当てれば、遅れて届いたレビューは古いジョブが受ける。
 * 15分より古い未到着のジョブ（投稿されずに終わったレビュー）は候補から外し、以後のレビューを
 * 受け止め続けて止めないようにする。レビューのコメントにはジョブを特定する印が無いため、
 * 「投稿されずに終わった前のジョブがある」ときは、その15分のあいだ次の計画の反映は見送られる。
 *
 * @returns 記録したジョブ。記録しなかったら`null`
 */
export const PLAN_REVIEW_POSTED_LOOKBACK_MS = 15 * 60 * 1000;

export async function markPlanReviewPosted(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBody: string;
  commentCreatedAt: Date;
}): Promise<{ jobId: string; createdAt: Date } | null> {
  if (!isPlanReviewCommentBody(params.commentBody)) return null;

  // **同じコメントのWebhookが再送されても、次のジョブへ二重に記録しない**（#3648）。「最も古い未記入」
  // へ割り当てるため、2回目は別の（次の計画の）ジョブを「届いた」ことにしてしまう
  const already = await db.dispatchJob.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      kind: "PLAN_REVIEW",
      reviewPostedAt: params.commentCreatedAt,
    },
    select: { id: true },
  });
  if (already) return null;

  const job = await db.dispatchJob.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      kind: "PLAN_REVIEW",
      status: "SUCCEEDED",
      reviewPostedAt: null,
      createdAt: {
        gte: new Date(params.commentCreatedAt.getTime() - PLAN_REVIEW_POSTED_LOOKBACK_MS),
        lte: params.commentCreatedAt,
      },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  if (!job) return null;
  await db.dispatchJob.update({
    where: { id: job.id },
    data: { reviewPostedAt: params.commentCreatedAt },
  });
  return { jobId: job.id, createdAt: job.createdAt };
}
