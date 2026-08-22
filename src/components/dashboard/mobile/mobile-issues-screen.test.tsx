// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

// 一覧本体はこの画面の関心事ではない（取得系フックを丸ごと抱えるため）ので差し替える。
// 先頭の固定枠（#1713。マージ待ちPR）と、引っ張って更新の呼び出し口（#2175）だけは通す
vi.mock("@/components/dashboard/issue-list", () => ({
  IssueList: ({
    pinnedSection,
    onPullToRefresh,
  }: {
    pinnedSection?: ReactNode;
    onPullToRefresh?: () => Promise<unknown> | void;
  }) => (
    <div data-testid="issue-list">
      {onPullToRefresh && (
        <button type="button" onClick={() => void onPullToRefresh()}>
          引っ張って更新
        </button>
      )}
      {pinnedSection}
    </div>
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
    manualStepVerifiedAt: null,
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function renderScreen(
  issues: Issue[],
  options: {
    view?: "all" | "check-user" | "manual-step";
    mergePendingPullRequests?: PullRequestSummary[];
    mergeCheckWaitingCount?: number;
    onRefresh?: () => Promise<unknown> | void;
    onRefreshPullRequests?: () => Promise<unknown> | void;
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
      mergeCheckWaitingCount={options.mergeCheckWaitingCount ?? 0}
      onSelectPullRequest={vi.fn()}
      onChangeView={vi.fn()}
      onChangeFilters={vi.fn()}
      onSelectIssue={vi.fn()}
      onCreateIssue={vi.fn()}
      onAskCrossRepoQuestion={vi.fn()}
      onStartManualStepGuide={vi.fn()}
      onRefresh={options.onRefresh}
      onRefreshPullRequests={options.onRefreshPullRequests}
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

    // Issue以外も並ぶビューなので、見出しは「Issue」ではなくビュー名（#2081）
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ユーザーの確認待ち");
    // ホーム画面の「要対応」と同じ2件になり、中身もその2件が並ぶ
    expect(screen.getByText("2件")).toBeTruthy();
    expect(screen.getByText("あなたのマージを待っているPull Request")).toBeTruthy();
    expect(screen.getByRole("button", { name: /v1.0.0をmainへリリースする/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toContain("2");
  });

  it("マージ待ちPRが無ければ枠ごと出さない", () => {
    renderScreen([], { view: "check-user" });

    expect(screen.getByText("0件")).toBeTruthy();
    expect(screen.queryByText("あなたのマージを待っているPull Request")).toBeNull();
  });
});

describe("MobileIssuesScreen のCI・判定の完了待ち（#2081）", () => {
  afterEach(() => {
    cleanup();
  });

  it("押せるPRが無くても、完了待ちがあれば件数だけを1行出す", () => {
    renderScreen([], { view: "check-user", mergeCheckWaitingCount: 3 });

    expect(
      screen.getByText(/CI・判定の完了待ちが3件あります/),
    ).toBeTruthy();
    // 件数には足さない（いま人が押せるものだけを数える）
    expect(screen.getByText("0件")).toBeTruthy();
    expect(screen.queryByText("あなたのマージを待っているPull Request")).toBeNull();
  });

  it("押せるPRがあるときは枠の中へ添える", () => {
    renderScreen([], {
      view: "check-user",
      mergePendingPullRequests: [makePullRequest()],
      mergeCheckWaitingCount: 2,
    });

    expect(screen.getByText("あなたのマージを待っているPull Request")).toBeTruthy();
    expect(screen.getByText(/CI・判定の完了待ちが2件あります/)).toBeTruthy();
    expect(screen.getByText("1件")).toBeTruthy();
  });
});

describe("MobileIssuesScreen のヘッダーの見出し（#2081）", () => {
  afterEach(() => {
    cleanup();
  });

  it("Issue以外も並ぶビューでは見出しをビュー名にし、下の行では重ねない", () => {
    renderScreen([], { view: "manual-step" });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ユーザーの作業待ち");
    expect(screen.queryByText(/^ユーザーの作業待ち・/)).toBeNull();
  });

  it("Issueだけが並ぶビューでは見出しは「Issue」のまま", () => {
    renderScreen([], { view: "all" });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Issue");
    expect(screen.getByText("すべてのIssue・0件")).toBeTruthy();
  });
});

describe("MobileIssuesScreen の引っ張って更新（#2175）", () => {
  afterEach(() => {
    cleanup();
  });

  it("確認待ちではIssueとマージ待ちPRの両方を取り直す", async () => {
    // この一覧の先頭にはマージ待ちPRが並ぶ（#1713）のに、確認待ちのビューではPRの
    // 自動更新を止めているため、Issueだけ取り直すと画面の上半分が開いた時点のまま残る。
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onRefreshPullRequests = vi.fn().mockResolvedValue(undefined);
    renderScreen([makeIssue()], { view: "check-user", onRefresh, onRefreshPullRequests });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "引っ張って更新" }));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefreshPullRequests).toHaveBeenCalledTimes(1);
  });

  it("他のビューではPRを取りに行かない", async () => {
    // 1回の取得でリポジトリ数ぶんのGitHub APIを使うため、PRが並ばない一覧では呼ばない
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onRefreshPullRequests = vi.fn().mockResolvedValue(undefined);
    renderScreen([makeIssue()], { view: "all", onRefresh, onRefreshPullRequests });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "引っ張って更新" }));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefreshPullRequests).not.toHaveBeenCalled();
  });
});
