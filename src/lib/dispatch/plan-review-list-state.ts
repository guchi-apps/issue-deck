import {
  findPlanReviewJobForIssue,
  isPlanReviewJobCreating,
  resolvePlanReviewJobPhase,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import { checkUserReason } from "@/lib/github/approval-labels";

/** Issue一覧の行に出す計画レビューの状態（#3607） */
export type PlanReviewListState = "queued" | "queued_overdue" | "creating";

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
 * - それ以外（作成を終えた後）は`null`。**「提示済」の状態は持たない**（#5571）。確認を求める
 *   段階は計画レビューが出ている（タイムアウトで出なかった場合を含む）前提で表示するため、
 *   一覧に「計画レビュー提示済」を出す意味が無い
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
  return null;
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
