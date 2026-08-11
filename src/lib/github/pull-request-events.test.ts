import { describe, expect, it } from "vitest";

import { buildPullRequestEvents } from "@/lib/github/pull-request-events";
import type { GithubApiComment } from "@/lib/github/issues-api";
import type {
  GithubApiPullRequestReview,
  GithubApiPullRequestReviewComment,
} from "@/lib/github/pull-requests-api";

function comment(overrides: Partial<GithubApiComment> = {}): GithubApiComment {
  return {
    id: 1,
    user: { login: "guchi" },
    body: "会話コメント",
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function review(overrides: Partial<GithubApiPullRequestReview> = {}): GithubApiPullRequestReview {
  return {
    id: 1,
    user: { login: "claude" },
    body: "レビュー総評",
    state: "APPROVED",
    submitted_at: "2026-08-01T01:00:00Z",
    ...overrides,
  };
}

function reviewComment(
  overrides: Partial<GithubApiPullRequestReviewComment> = {},
): GithubApiPullRequestReviewComment {
  return {
    id: 1,
    user: { login: "claude" },
    body: "この分岐は不要です",
    created_at: "2026-08-01T02:00:00Z",
    path: "src/lib/foo.ts",
    line: 12,
    ...overrides,
  };
}

describe("buildPullRequestEvents", () => {
  it("3種類のイベントを時系列（古い順）に1本へまとめる", () => {
    const events = buildPullRequestEvents({
      comments: [comment({ id: 10, created_at: "2026-08-01T03:00:00Z" })],
      reviews: [review({ id: 20, submitted_at: "2026-08-01T01:00:00Z" })],
      reviewComments: [reviewComment({ id: 30, created_at: "2026-08-01T02:00:00Z" })],
    });

    expect(events.map((event) => event.id)).toEqual([
      "review-20",
      "review-comment-30",
      "comment-10",
    ]);
    expect(events.map((event) => event.kind)).toEqual(["review", "review-comment", "comment"]);
  });

  it("レビューの状態を画面表示用の値へ正規化する", () => {
    const events = buildPullRequestEvents({
      comments: [],
      reviews: [
        review({ id: 1, state: "APPROVED" }),
        review({ id: 2, state: "CHANGES_REQUESTED", submitted_at: "2026-08-01T02:00:00Z" }),
      ],
      reviewComments: [],
    });

    expect(events.map((event) => event.reviewState)).toEqual(["approved", "changes_requested"]);
  });

  it("未送信（PENDING）のレビューは含めない", () => {
    const events = buildPullRequestEvents({
      comments: [],
      reviews: [review({ state: "PENDING", submitted_at: null })],
      reviewComments: [],
    });

    expect(events).toEqual([]);
  });

  it("総評が空のCOMMENTEDレビューは行コメントと重複するため含めない", () => {
    const events = buildPullRequestEvents({
      comments: [],
      reviews: [review({ id: 1, state: "COMMENTED", body: "" })],
      reviewComments: [reviewComment({ id: 2 })],
    });

    expect(events.map((event) => event.id)).toEqual(["review-comment-2"]);
  });

  it("総評があるCOMMENTEDレビューは残す", () => {
    const events = buildPullRequestEvents({
      comments: [],
      reviews: [review({ id: 1, state: "COMMENTED", body: "全体的に問題ありません" })],
      reviewComments: [],
    });

    expect(events.map((event) => event.id)).toEqual(["review-1"]);
  });

  it("レビューコメントは指摘対象のファイルと行を保持する", () => {
    const [event] = buildPullRequestEvents({
      comments: [],
      reviews: [],
      reviewComments: [reviewComment({ path: "src/app/page.tsx", line: 42 })],
    });

    expect(event.path).toBe("src/app/page.tsx");
    expect(event.line).toBe(42);
  });

  it("投稿者が取得できないコメントはunknownとして扱う", () => {
    const [event] = buildPullRequestEvents({
      comments: [comment({ user: null, body: null })],
      reviews: [],
      reviewComments: [],
    });

    expect(event.authorLogin).toBe("unknown");
    expect(event.body).toBe("");
  });

  it("同時刻のイベントはIDで安定して並ぶ", () => {
    const at = "2026-08-01T00:00:00Z";
    const events = buildPullRequestEvents({
      comments: [comment({ id: 2, created_at: at }), comment({ id: 1, created_at: at })],
      reviews: [],
      reviewComments: [],
    });

    expect(events.map((event) => event.id)).toEqual(["comment-1", "comment-2"]);
  });
});
