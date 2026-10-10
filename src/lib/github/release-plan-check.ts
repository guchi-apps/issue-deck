import {
  PLAN_REVIEW_MARKER,
  findPendingPlanReviewComment,
  hasBlockingFindings,
  parsePlanReview,
  resolvePlanReviewNotice,
} from "@/lib/github/plan-review";
import { isPlanComment } from "@/lib/github/planning-phase";
import type { IssueComment } from "@/types/issue";
import type { ReleaseChangePlanCheck } from "@/types/pull-request";

type Comment = Pick<IssueComment, "body" | "author" | "authorTrusted">;

/**
 * 関連Issueのコメントから、計画レビューの記録を決める（#4305）。
 *
 * **判定は既存の関数群に揃える**——マーカーは誰でも書けるので、`authorTrusted`の投稿者だけを見る
 * （#3716。`findPendingPlanReviewComment`・`resolvePlanReviewNotice`が内部で見ている）。新しい
 * 判定を別に書かず、計画の詳細画面と食い違わないようにする。
 */
export function resolvePlanCheck(comments: readonly Comment[]): ReleaseChangePlanCheck {
  const pending = findPendingPlanReviewComment(comments);
  if (pending) {
    const review = parsePlanReview(pending.body);
    const first = review.findings[0]?.title ?? null;
    return hasBlockingFindings(review)
      ? { state: "findings", reason: first ? `未応答の指摘: ${first}` : "未応答の指摘があります" }
      : { state: "reviewed", reason: "補足のみの指摘（応答待ち）" };
  }
  const notice = resolvePlanReviewNotice(comments);
  if (notice) return { state: notice.kind, reason: notice.text || null };

  const trusted = comments.filter((comment) => comment.authorTrusted === true);
  if (!trusted.some(isPlanComment)) return { state: "no-plan", reason: "計画の記録がありません" };
  if (trusted.some((comment) => comment.body.includes(PLAN_REVIEW_MARKER))) {
    return { state: "reviewed", reason: "計画レビューに応答済み" };
  }
  return { state: "unreviewed", reason: "計画レビューの記録がありません" };
}
