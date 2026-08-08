// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("CommentThread ボットの役割表示", () => {
  afterEach(() => {
    cleanup();
  });

  it("issue-deck-sourceマーカー付きのbotコメントはヘッダに役割の表示名を表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "対応完了しました\n\n<!-- issue-deck-source:issue-labels -->",
      }),
    ]);
    expect(screen.getByText("進捗通知ボット")).not.toBeNull();
  });

  it("計画コメントはヘッダに計画ボットを表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "計画本文\n\n<!-- issue-deck-plan-type:split -->",
      }),
    ]);
    expect(screen.getByText("分割ボット")).not.toBeNull();
  });

  it("issue-deck-agentマーカー付きのbotコメントはヘッダに役割の表示名を表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "着手します\n\n<!-- issue-deck-agent:implementer -->\n\n<!-- issue-deck-source:claude-issue-dispatch -->",
      }),
    ]);
    expect(screen.getByText("実装ボット")).not.toBeNull();
  });

  it("人間のコメントにはヘッダにloginをそのまま表示する", () => {
    renderThread([makeComment({ author: { login: "m-guchi" }, body: "通常のコメント" })]);
    expect(screen.getByText("m-guchi")).not.toBeNull();
  });

  it("マーカーの無いbotコメントにはヘッダにloginをそのまま表示する（汎用ボット扱い）", () => {
    renderThread([
      makeComment({ author: { login: "github-actions[bot]" }, body: "マーカーの無いコメント" }),
    ]);
    expect(screen.getByText("github-actions[bot]")).not.toBeNull();
  });
});

describe("CommentThread 左右の吹き出し", () => {
  afterEach(() => {
    cleanup();
  });

  it("currentUserLoginと一致するコメントは右寄せの吹き出しになる", () => {
    render(
      <CommentThread
        comments={[makeComment({ author: { login: "m-guchi" }, body: "自分のコメント" })]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("自分のコメント").closest("li")?.querySelector(":scope > div");
    expect(row?.className).toContain("flex-row-reverse");
  });

  it("currentUserLoginと一致しないコメントは左寄せのままになる", () => {
    render(
      <CommentThread
        comments={[makeComment({ author: { login: "other-user" }, body: "他の人のコメント" })]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("他の人のコメント").closest("li")?.querySelector(":scope > div");
    expect(row?.className).not.toContain("flex-row-reverse");
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

describe("CommentThread PRマージ待ちの表示", () => {
  afterEach(() => {
    cleanup();
  });

  it("マージ実行後は「マージが必要です」ではなく完了の表示に切り替わる", async () => {
    render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        pullRequestLink={{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
      />,
    );

    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(screen.getByText("Pull Requestをマージしました")).not.toBeNull();
    });
    expect(screen.queryByText("Pull Requestのマージが必要です")).toBeNull();
    expect(screen.queryByText("修正を依頼する")).toBeNull();
  });
});
