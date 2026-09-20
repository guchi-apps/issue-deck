import {
  isCodeReviewPending,
  summarizeCodeReviewComments,
  summarizeCodeReviewFindingProgress,
  type CodeReviewSummary,
} from "@/lib/github/code-review";
import { COMMENT_SOURCE_MARKER } from "@/lib/github/progress-sweep";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * 全指摘が対応済みになったコードレビューIssueを、巡回で自動closeする（#3216）。
 *
 * 「コードレビュー」画面の一覧は、レビューIssueの行に`対応済み n/n`を出す（#2868）。
 * 読み終えたレビューは**closeすると一覧から外れる**（#3141）が、そのcloseは人の手だった。
 * 画面が「対応済み」と数えたものと**同じ判定**（`summarizeCodeReviewFindingProgress`の
 * `resolved === total`）を巡回から使い、行の見た目と自動closeが食い違わないようにする。
 *
 * ここに置くのは判定と文面だけ（純粋関数）。DB・GitHubに触る側は
 * [`code-review-close-sweep-run.ts`](./code-review-close-sweep-run.ts)。
 */

/** 見送った理由のうち、平常時に毎巡回起きるもの。ログには出さず、件数にも数えない */
export type CodeReviewCloseQuietSkipReason =
  /** 結果がまだ返っていない、または依頼も結果も無い */
  | "not_reported"
  /** 指摘が0件（`指摘なし`）。閉じる根拠になる「対応済み」が無い */
  | "no_findings"
  /** 未起票または未closeの指摘が残っている */
  | "unresolved";

/** 見送った理由のうち、closeすると決めた後に止まったもの。巡回の`skipped`へ数える */
export type CodeReviewCloseSkipReason =
  /** closeの直前に取り直すと、再レビューの依頼が結果より後ろに来ていた */
  | "review_rerun_pending"
  /** 取り直すと、判定に使った結果と別の結果（指摘の並び）に変わっていた */
  | "review_report_changed"
  /** 人が開け直したことがある。閉じ直さない */
  | "review_reopened"
  /** 開け直しの有無を確かめられなかった。次の巡回で引き直す */
  | "review_reopen_unknown";

export type CodeReviewCloseDecision =
  | { action: "close"; total: number }
  | { action: "skip"; reason: CodeReviewCloseQuietSkipReason };

/**
 * レビューIssue1件を閉じてよいかを、結果の要約と手元のIssue（指摘の起票先）から決める。
 *
 * **閉じるのは、指摘が1件以上あり、その全部が起票済みでcloseされているとき。**
 * `指摘なし`のレビューは対象にしない（画面にも「対応済み」は出ない。読み終えたかどうかは人が決める）。
 */
export function decideCompletedCodeReview(params: {
  summary: Pick<CodeReviewSummary, "state" | "findingTitles">;
  /** 引き当て先のIssue。指摘の見出しと同じタイトルのものが入っていればよい */
  issues: readonly Pick<Issue, "repositoryFullName" | "title" | "number" | "state">[];
  repositoryFullName: string;
}): CodeReviewCloseDecision {
  if (params.summary.state !== "reported") return { action: "skip", reason: "not_reported" };
  const progress = summarizeCodeReviewFindingProgress({
    findingTitles: params.summary.findingTitles,
    issues: params.issues,
    repositoryFullName: params.repositoryFullName,
  });
  if (!progress) return { action: "skip", reason: "no_findings" };
  if (progress.resolved !== progress.total) return { action: "skip", reason: "unresolved" };
  return { action: "close", total: progress.total };
}

/**
 * closeの直前に、取り直したコメントで確かめる（キャッシュした要約は最大5分遅れうる）。
 *
 * - 結果の後に**再レビューの依頼**が来ていたら閉じない。要約は「最後の結果」を読むため、
 *   再レビューが走っている最中でも古い結果が`reported`のまま見えてしまう
 * - 判定に使った結果と**指摘の並びが変わっていたら**閉じない（次の巡回で判定し直す）
 */
export function verifyCompletedCodeReview(params: {
  comments: readonly Pick<IssueComment, "body">[];
  /** 判定に使った要約の`findingTitles` */
  findingTitles: readonly string[];
}): "ok" | "review_rerun_pending" | "review_report_changed" {
  if (isCodeReviewPending(params.comments)) return "review_rerun_pending";
  const fresh = summarizeCodeReviewComments(params.comments).findingTitles;
  const same =
    fresh.length === params.findingTitles.length &&
    fresh.every((title, index) => title === params.findingTitles[index]);
  return same ? "ok" : "review_report_changed";
}

/** 自動closeしたときに残すコメント。なぜ閉じたのかと、開け直せば閉じ直さないことを伝える */
export function buildCodeReviewAutoClosedComment(total: number): string {
  return [
    `✅ 指摘${total}件がすべて対応済み（指摘から起票したIssueがすべてcloseされている）ため、このレビューIssueをcloseしました。`,
    "",
    "まだ対応が残っている場合は、このIssueを開き直してください（開き直したものは自動では閉じません）。",
    "",
    COMMENT_SOURCE_MARKER,
  ].join("\n");
}
