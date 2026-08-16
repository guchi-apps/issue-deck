// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

// 一覧本体はこの画面の関心事ではない（取得系フックを丸ごと抱えるため）ので差し替える。
// 先頭の固定枠（#1713。マージ待ちPR）だけは通す
vi.mock("@/components/dashboard/issue-list", () => ({
  IssueList: ({ pinnedSection }: { pinnedSection?: ReactNode }) => (
    <div data-testid="issue-list">{pinnedSection}</div>
  ),
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

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "owner/repo#10",
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    number: 10,
    title: "v1.0.0をmainへリリースする",
    htmlUrl: "https://github.com/owner/repo/pull/10",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "main",
    headRef: "develop",
    kind: "release",
    linkedIssueNumber: null,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeable: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function renderScreen(
  issues: Issue[],
  options: {
    view?: "all" | "check-user";
    mergePendingPullRequests?: PullRequestSummary[];
  } = {},
) {
  render(
    <MobileIssuesScreen
      issues={issues}
      currentUserLogin={null}
      labelSummary={[]}
      assigneeOptions={[]}
      selectedIssueId={null}
      view={options.view ?? "all"}
      labels={[]}
      state="open"
      assignee={null}
      sort="created"
      mergePendingPullRequests={options.mergePendingPullRequests ?? []}
      onSelectPullRequest={vi.fn()}
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

describe("MobileIssuesScreen の確認待ちに並ぶマージ待ちPR（#1713）", () => {
  afterEach(() => {
    cleanup();
  });

  it("確認待ちのIssueが0件でも、マージ待ちPRを一覧に出して件数にも数える", () => {
    renderScreen([], {
      view: "check-user",
      mergePendingPullRequests: [
        makePullRequest(),
        makePullRequest({
          id: "owner/other#3",
          repositoryFullName: "owner/other",
          number: 3,
          title: "v2.0.0をmainへリリースする",
        }),
      ],
    });

    // ホーム画面の「要対応」と同じ2件になり、中身もその2件が並ぶ
    expect(screen.getByText("ユーザーの確認待ち・2件")).toBeTruthy();
    expect(screen.getByText("あなたのマージを待っているPull Request")).toBeTruthy();
    expect(screen.getByRole("button", { name: /v1.0.0をmainへリリースする/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toContain("2");
  });

  it("マージ待ちPRが無ければ枠ごと出さない", () => {
    renderScreen([], { view: "check-user" });

    expect(screen.getByText("ユーザーの確認待ち・0件")).toBeTruthy();
    expect(screen.queryByText("あなたのマージを待っているPull Request")).toBeNull();
  });
});
