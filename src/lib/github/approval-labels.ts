import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import type { IssueLabel } from "@/types/issue";

/** ユーザーの確認・指示が必要であることを示すラベル */
export const CHECK_USER_LABEL = "00.check-user";

/** 実装前の計画承認待ちであることを示すラベル */
export const PLAN_REQUIRED_LABEL = "21.plan-required";

/** developへのPR作成・マージ中であることを示すワークフロー状況ラベル */
const D_MARGE_LABEL = "03.d:marge";

/** mainへのPR作成・マージ中であることを示すワークフロー状況ラベル */
const M_MARGE_LABEL = "07.m:marge";

export function isApprovalPending(labels: IssueLabel[]): boolean {
  return labels.some((label) => label.name === CHECK_USER_LABEL);
}

/**
 * 00.check-userかつワークフロー状況が03.d:marge/07.m:margeの場合、PRマージ待ち
 * （GitHub上で人間が直接マージする必要があり、@claudeコメントでの再開対象ではない）と判定する。
 */
export function isMergeApprovalPending(labels: IssueLabel[]): boolean {
  if (!isApprovalPending(labels)) return false;
  const stepIndex = getWorkflowStepIndex(labels);
  if (stepIndex === null) return false;
  const stepLabel = WORKFLOW_STEPS[stepIndex].labelName;
  return stepLabel === D_MARGE_LABEL || stepLabel === M_MARGE_LABEL;
}

/** 承認時に外すラベル名の配列を返す（00.check-userに加え、計画承認待ちなら21.plan-requiredも外す） */
export function labelsAfterApproval(labels: IssueLabel[]): string[] {
  return labels
    .map((label) => label.name)
    .filter((name) => name !== CHECK_USER_LABEL && name !== PLAN_REQUIRED_LABEL);
}

/**
 * 却下（UI上のボタン表記は「修正」）時に外すラベル名の配列を返す（00.check-userのみを
 * 外す。21.plan-requiredは計画の再提示が必要なため残す）
 */
export function labelsAfterRejection(labels: IssueLabel[]): string[] {
  return labels.map((label) => label.name).filter((name) => name !== CHECK_USER_LABEL);
}

/**
 * 承認ボタン押下時、ラベル更新に続けて投稿する定型コメント本文
 * （claude-issue-dispatch.ymlの@claudeトリガーに反応する）。
 *
 * ラベル更新はissue-deckのGitHub App（インストールトークン）で行うためGitHub上は
 * issue-deck[bot]の操作として記録され、issues.unlabeledイベントだけでは実際に
 * 承認操作をした人間を特定できず、ワークフロー側の自己ループ防止ロジックにより
 * 実装が再開されない（#173）。GitHub Appの人力アプリ操作であっても
 * 個人のGitHubアカウントで投稿されるコメント（POST /api/issues/comments、
 * user.githubAccessToken使用）を承認ラベル更新の直後に送ることで、
 * issue_commentトリガー経由で実装を確実に再開させる。
 *
 * 21.plan-requiredによる計画承認待ちの場合と、それ以外（画面確認待ち・フォールバック
 * エラー通知など）の汎用確認待ちの場合とで、「計画」という語を含むかどうかの文言を変える。
 */
export function approveCommentBody(labels: IssueLabel[]): string {
  const isPlanApproval = labels.some((label) => label.name === PLAN_REQUIRED_LABEL);
  return isPlanApproval
    ? "@claude 計画を承認しました。実装を進めてください。"
    : "@claude 確認しました。実装を進めてください。";
}
