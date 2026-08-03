import type { IssueComment } from "@/types/issue";

/**
 * claude-issue-dispatch.ymlが、計画コメント投稿・実装結果報告（コメント投稿またはPR作成）の
 * いずれも確認できなかった場合に投稿するフォールバック通知コメントの末尾に付与するマーカー。
 */
export const FALLBACK_NOTICE_MARKER = "<!-- issue-deck-fallback-notice -->";

/** 指定したコメントが、ワークフローのフォールバック通知（行き詰まり・エラー終了）かどうかを判定する */
export function isFallbackNoticeComment(comment: IssueComment): boolean {
  return comment.body.includes(FALLBACK_NOTICE_MARKER);
}
