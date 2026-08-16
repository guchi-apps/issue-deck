// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import type { Issue } from "@/types/issue";

// 一覧本体はこの画面の関心事ではない（取得系フックを丸ごと抱えるため）ので差し替える
vi.mock("@/components/dashboard/issue-list", () => ({
  IssueList: () => <div data-testid="issue-list" />,
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function renderScreen(issues: Issue[]) {
  render(
    <MobileIssuesScreen
      issues={issues}
      currentUserLogin={null}
      labelSummary={[]}
      assigneeOptions={[]}
      selectedIssueId={null}
      view="all"
      labels={[]}
      state="open"
      assignee={null}
      sort="created"
      onChangeView={vi.fn()}
      onChangeFilters={vi.fn()}
      onSelectIssue={vi.fn()}
      onCreateIssue={vi.fn()}
      onAskCrossRepoQuestion={vi.fn()}
    />,
  );
}

describe("MobileIssuesScreen のビュー件数（#1689）", () => {
  afterEach(() => {
    cleanup();
  });

  it("状態の絞り込みを適用した件数を出す（close済みを数えない）", () => {
    renderScreen([
      makeIssue({ id: "1" }),
      makeIssue({ id: "2" }),
      makeIssue({ id: "3", state: "closed", closedAt: "2026-01-09T10:00:00.000Z" }),
    ]);

    // ヘッダーの件数（＝一覧に並ぶ件数）とビュー選択ボタンの件数が揃っていること
    expect(screen.getByText("すべてのIssue・2件")).toBeTruthy();
    expect(screen.getByRole("button", { name: /すべてのIssue/ }).textContent).toContain("2");
  });
});
