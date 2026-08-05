import type { IssueComment } from "@/types/issue";

/**
 * claude-issue-dispatch.ymlが、計画コメント投稿・実装結果報告（コメント投稿またはPR作成）の
 * いずれも確認できなかった場合に投稿するフォールバック通知コメントの末尾に付与するマーカー。
 */
export const FALLBACK_NOTICE_MARKER = "<!-- issue-deck-fallback-notice -->";

// claude-issue-dispatch.yml / claude-conflict-resolve.ymlは、フォールバック通知の本文末尾に
// 空行区切りでFALLBACK_NOTICE_MARKERを付与する（`...\n\n<!-- issue-deck-fallback-notice -->`）。
// 単純な部分文字列一致だと、計画コメント等でマーカー文字列を引用しただけの通常コメントも
// 誤ってフォールバック通知として扱ってしまうため、本文末尾での厳密な一致のみ許可する。
const FALLBACK_NOTICE_MARKER_PATTERN = /\n\n<!-- issue-deck-fallback-notice -->$/;

/** 指定したコメントが、ワークフローのフォールバック通知（行き詰まり・エラー終了）かどうかを判定する */
export function isFallbackNoticeComment(comment: Pick<IssueComment, "body">): boolean {
  return FALLBACK_NOTICE_MARKER_PATTERN.test(comment.body);
}
