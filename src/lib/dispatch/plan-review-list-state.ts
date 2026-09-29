import {
  findPlanReviewJobForIssue,
  isPlanReviewJobCreating,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import { checkUserReason } from "@/lib/github/approval-labels";

/** Issue一覧の行に出す計画レビューの状態（#3607） */
export type PlanReviewListState = "creating" | "presented";

/**
 * 計画レビュー（G1）の状態を一覧の行向けに判定する。
 *
 * - `creating`: ジョブが実行中、または成功から猶予内（`isPlanReviewJobCreating`。詳細画面と同じ）
 * - `presented`: 成功したジョブがあり、計画の承認待ち（`00.check-user`＋`01.check-plan`）のとき。
 *   承認待ちは`WAITING`ではなくラベルで見る（`WAITING`は期限切れで一覧から消えるため）。
 *   計画リクエストが残っている間は、ジョブが今の計画に対するもの（作成が計画より後）に限る。
 *   期限切れ後は比較できないので、ジョブの存在だけで判定する
 *
 * 一覧はコメント本文を持たないため、指摘コメントの実在までは見ない。
 */
export function resolvePlanReviewListState(params: {
  jobs: readonly DispatchJobView[];
  planRequest: Pick<SessionPlanRequestView, "createdAt"> | null;
  labels: Parameters<typeof checkUserReason>[0];
  repositoryFullName: string;
  issueNumber: number;
  now: Date;
}): PlanReviewListState | null {
  const job = findPlanReviewJobForIssue(params.jobs, params.repositoryFullName, params.issueNumber);
  if (job === null) return null;
  if (isPlanReviewJobCreating(job, params.now)) return "creating";
  if (job.status !== "SUCCEEDED") return null;
  if (checkUserReason(params.labels) !== "plan") return null;
  if (params.planRequest !== null && job.createdAt < params.planRequest.createdAt) return null;
  return "presented";
}
