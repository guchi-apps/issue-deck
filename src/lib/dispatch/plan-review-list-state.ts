import {
  findPlanReviewJobForIssue,
  isPlanReviewJobCreating,
  resolvePlanReviewJobPhase,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import { checkUserReason } from "@/lib/github/approval-labels";

/** Issue一覧の行に出す計画レビューの状態（#3607） */
export type PlanReviewListState = "queued" | "queued_overdue" | "creating" | "presented";

/**
 * 計画の承認を伏せる（「計画を承認」ボタン・承認待ちの橙・Remoteの強調を出さない）状態か（#4869）。
 *
 * 起動待ちも猶予内（`queued`）は作成中と同じに扱う。Issue詳細の承認パネル・通知・件数が読む
 * `isPlanReviewJobCreating`と同じ線で、猶予を超えた起動待ち（`queued_overdue`）は承認できる状態へ戻す。
 */
export function isPlanReviewListStateHolding(state: PlanReviewListState | null): boolean {
  return state === "queued" || state === "creating";
}

/**
 * 計画レビュー（G1）の状態を一覧の行向けに判定する。
 *
 * - `queued`: ジョブが起動待ち（`QUEUED`。#3772）で、積んでから猶予内
 * - `queued_overdue`: 猶予を超えても起動していない。バッジは起動待ちのまま出し続けるが、
 *   承認は伏せない（#4869。`isPlanReviewListStateHolding`）
 * - `creating`: ジョブが実行中、または成功から猶予内（`resolvePlanReviewJobPhase`。詳細画面と同じ）
 * - `presented`: 成功したジョブがあり、計画の承認待ち（`00.check-user`＋`01.check-plan`）のとき。
 *   承認待ちは`WAITING`ではなくラベルで見る（`WAITING`は期限切れで一覧から消えるため）。
 *   計画リクエストが残っている間は、ジョブが今の計画に対するもの（作成が計画より後）に限る。
 *   期限切れ後は比較できないので、ジョブの存在だけで判定する（新しいジョブが積まれないまま
 *   承認待ちが期限切れになった後は、前回のジョブで「提示済」が出うる）
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
  const phase = resolvePlanReviewJobPhase(job, params.now);
  if (phase === "queued" || phase === "queued_overdue") return phase;
  if (phase === "creating") return "creating";
  if (job.status !== "SUCCEEDED") return null;
  if (checkUserReason(params.labels) !== "plan") return null;
  // 今の計画待ちより前に積まれたジョブは前の計画へのレビュー。**計画待ちはレビューのジョブより
  // 先に作られる前提**（`POST /api/dispatch/sessions/plan`。#3697）
  if (params.planRequest !== null && job.createdAt < params.planRequest.createdAt) return null;
  return "presented";
}

/**
 * 計画レビューを作成中のIssueのid集合（#3701）。
 *
 * 作成中は指摘が付くまでの数分間で、開いても押して進める操作が無い。件数からは#3625で
 * 外してあるが、「ユーザーの確認待ち」の一覧にも並ばないよう、一覧側が同じ集合を読む。
 */
export function selectPlanReviewCreatingIssueIds(
  issues: readonly { id: string; repositoryFullName: string; number: number }[],
  jobs: readonly DispatchJobView[],
  now: Date,
): Set<string> {
  const ids = new Set<string>();
  for (const issue of issues) {
    const job = findPlanReviewJobForIssue(jobs, issue.repositoryFullName, issue.number);
    if (isPlanReviewJobCreating(job, now)) ids.add(issue.id);
  }
  return ids;
}
