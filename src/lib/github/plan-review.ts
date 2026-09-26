import { isPlanComment } from "@/lib/github/planning-phase";
import type { IssueComment } from "@/types/issue";

const PLAN_REVIEW_MARKER = "<!-- supervisor:plan-review -->";
const PLAN_REVISER_MARKER = "<!-- issue-deck-agent:plan-reviser -->";

/**
 * 最新の計画コメントより後に計画レビューが届いていて、まだ実装エージェントが応答していないか（#3521）。
 * コメントに時刻は無いので、並び順（時系列）で判定する。計画コメントの判定は`isPlanComment`を使う
 * （`plan-base`の行は付かない計画があるため、それをアンカーにしない）。
 */
export function isPlanReviewPending(
  comments: readonly Pick<IssueComment, "body" | "author">[],
): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.body.includes(PLAN_REVISER_MARKER)) return false;
    if (comment.body.includes(PLAN_REVIEW_MARKER)) return true;
    if (isPlanComment(comment)) return false;
  }
  return false;
}
