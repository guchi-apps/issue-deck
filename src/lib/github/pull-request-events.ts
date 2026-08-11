import type { GithubApiComment } from "@/lib/github/issues-api";
import type {
  GithubApiPullRequestReview,
  GithubApiPullRequestReviewComment,
} from "@/lib/github/pull-requests-api";
import type { PullRequestEvent, PullRequestReviewState } from "@/types/pull-request";

/** GitHubのレビュー`state`（大文字）を画面表示用の値へ正規化する対応表 */
const REVIEW_STATES: Record<string, PullRequestReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/**
 * PRの会話コメント・レビュー・レビューコメントを1本の時系列にまとめる。
 *
 * 取得元は3エンドポイントに分かれている（issueコメント / pulls reviews / pulls comments）が、
 * 画面では「そのPRで何が起きたか」を上から順に読めればよい。GitHubのPR画面と違い、
 * レビューコメントを親レビューにぶら下げず、フラットに時刻順で並べる（issue-deckで扱うPRは
 * 無人実行が作るものが大半で、レビューのまとまりより時系列の読みやすさが勝るため）。
 */
export function buildPullRequestEvents(input: {
  comments: GithubApiComment[];
  reviews: GithubApiPullRequestReview[];
  reviewComments: GithubApiPullRequestReviewComment[];
}): PullRequestEvent[] {
  const events: PullRequestEvent[] = [];

  for (const comment of input.comments) {
    events.push({
      id: `comment-${comment.id}`,
      kind: "comment",
      authorLogin: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      reviewState: null,
      path: null,
      line: null,
    });
  }

  for (const review of input.reviews) {
    const reviewState = REVIEW_STATES[review.state];
    // 下書き（PENDING）は投稿者本人にしか見えない未送信のレビューで、送信時刻も持たない。
    if (!reviewState || !review.submitted_at) continue;
    const body = review.body ?? "";
    // 行コメントだけを付けたレビューは総評が空になる。中身は review-comment として
    // 別に並ぶため、空の「コメントしました」を重ねて出さない。
    if (body.trim() === "" && reviewState === "commented") continue;
    events.push({
      id: `review-${review.id}`,
      kind: "review",
      authorLogin: review.user?.login ?? "unknown",
      body,
      createdAt: review.submitted_at,
      reviewState,
      path: null,
      line: null,
    });
  }

  for (const comment of input.reviewComments) {
    events.push({
      id: `review-comment-${comment.id}`,
      kind: "review-comment",
      authorLogin: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      reviewState: null,
      path: comment.path,
      line: comment.line,
    });
  }

  return sortPullRequestEvents(events);
}

/** 古い順に並べる。同時刻のイベントはIDで安定させる（取得順に依存させない） */
export function sortPullRequestEvents(events: PullRequestEvent[]): PullRequestEvent[] {
  return [...events].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}
