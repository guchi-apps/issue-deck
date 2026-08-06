// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommentThread } from "@/components/dashboard/comment-thread";
import type { IssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import type { IssueComment } from "@/types/issue";

const commentSummary: IssueCommentSummaries = {
  summaries: {},
  generatingIds: new Set(),
  errors: {},
  notConfigured: false,
  generate: async () => {},
};

function makeComment(overrides: Partial<IssueComment>): IssueComment {
  return {
    id: "1",
    author: { login: "m-guchi" },
    createdAtLabel: "1時間前",
    body: "コメント本文",
    reactionCount: 0,
    ...overrides,
  };
}

function renderThread(comments: IssueComment[]) {
  return render(
    <CommentThread
      comments={comments}
      repositoryFullName="m-guchi/issue-deck"
      issueSuggestions={[]}
      onUpdate={async () => true}
      onDelete={async () => true}
      commentSummary={commentSummary}
    />,
  );
}

describe("CommentThread 投稿元バッジ", () => {
  afterEach(() => {
    cleanup();
  });

  it("issue-deck-sourceマーカー付きのbotコメントに投稿元バッジを表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "対応完了しました\n\n<!-- issue-deck-source:issue-labels -->",
      }),
    ]);
    expect(screen.getByText("自動処理")).not.toBeNull();
  });

  it("計画コメントには計画種別付きのバッジを表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "計画本文\n\n<!-- issue-deck-plan-type:split -->",
      }),
    ]);
    expect(screen.getByText("Claude Code（分割計画）")).not.toBeNull();
  });

  it("人間のコメントには投稿元バッジを表示しない", () => {
    renderThread([makeComment({ author: { login: "m-guchi" }, body: "通常のコメント" })]);
    expect(screen.queryByText("自動処理")).toBeNull();
    expect(screen.queryByText("不明な自動投稿")).toBeNull();
  });

  it("マーカーの無いbotコメントには「不明な自動投稿」バッジを表示する", () => {
    renderThread([
      makeComment({ author: { login: "github-actions[bot]" }, body: "マーカーの無いコメント" }),
    ]);
    expect(screen.getByText("不明な自動投稿")).not.toBeNull();
  });
});

describe("CommentThread AI要約の表示位置", () => {
  afterEach(() => {
    cleanup();
  });

  it("長文コメントではAI要約を本文より前に表示する", () => {
    const body = `本文の先頭${"あ".repeat(500)}`;
    renderThread([makeComment({ body })]);

    const summaryLabel = screen.getByText("AI要約");
    const bodyText = screen.getByText(body);
    // Node.DOCUMENT_POSITION_FOLLOWING: summaryLabel より後ろに bodyText がある
    expect(summaryLabel.compareDocumentPosition(bodyText) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("短いコメントにはAI要約を表示しない", () => {
    renderThread([makeComment({ body: "短いコメント" })]);

    expect(screen.queryByText("AI要約")).toBeNull();
  });
});
