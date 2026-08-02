import type { IssueLabel } from "@/types/issue";

/** ユーザーの確認・指示が必要であることを示すラベル */
export const CHECK_USER_LABEL = "00.check-user";

/** 実装前の計画承認待ちであることを示すラベル */
export const PLAN_REQUIRED_LABEL = "21.plan-required";

export function isApprovalPending(labels: IssueLabel[]): boolean {
  return labels.some((label) => label.name === CHECK_USER_LABEL);
}

/** 承認時に外すラベル名の配列を返す（00.check-userに加え、計画承認待ちなら21.plan-requiredも外す） */
export function labelsAfterApproval(labels: IssueLabel[]): string[] {
  return labels
    .map((label) => label.name)
    .filter((name) => name !== CHECK_USER_LABEL && name !== PLAN_REQUIRED_LABEL);
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
 */
export const APPROVE_COMMENT_BODY = "@claude 計画を承認しました。実装を進めてください。";
