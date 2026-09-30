// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import type { Issue } from "@/types/issue";

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
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function renderScreen(
  issues: Issue[],
  options: {
    view?: "all" | "check-user" | "manual-step";
    mergePendingIssueKeys?: ReadonlySet<string>;
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
      mergePendingIssueKeys={options.mergePendingIssueKeys}
      onChangeView={vi.fn()}
      onChangeFilters={vi.fn()}
      onSelectIssue={vi.fn()}
      onStartManualStepGuide={vi.fn()}
    />,
  );
}

/**
 * ヘッダーの見出しと件数の行を包む要素。**件数の「N件」はヘッダーの外にも出る**ため
 * （#3165でマージ待ちPRの見出しに総件数のバッジが付いた）、ここへ絞って読む。
 */
function headerOf(): HTMLElement {
  return screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
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

const CHECK_USER_LABEL = { name: "00.check-user", color: "red", description: null };

describe("MobileIssuesScreen の確認待ちからマージ待ちを外す（#3650）", () => {
  afterEach(() => {
    cleanup();
  });

  it("マージ待ちPRの対応Issueは確認待ちの一覧と件数から除く", () => {
    renderScreen(
      [
        makeIssue({ id: "1", number: 1, labels: [CHECK_USER_LABEL] }),
        makeIssue({ id: "2", number: 2, labels: [CHECK_USER_LABEL] }),
      ],
      { view: "check-user", mergePendingIssueKeys: new Set(["owner/repo#2"]) },
    );

    expect(within(headerOf()).getByText("1件")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toContain("1");
  });

  it("対応するPRが無いIssue（事後の確認など）は確認待ちに残す", () => {
    renderScreen([makeIssue({ id: "1", number: 1, labels: [CHECK_USER_LABEL] })], {
      view: "check-user",
      mergePendingIssueKeys: new Set(["owner/repo#99"]),
    });

    expect(within(headerOf()).getByText("1件")).toBeTruthy();
  });

  it("マージ待ちPRの枠は出さない（マージ待ちは「Pull Request」のタイルで見る）", () => {
    renderScreen([], { view: "check-user" });

    expect(screen.getByText("0件")).toBeTruthy();
    expect(screen.queryByText("あなたのマージを待っているPull Request")).toBeNull();
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
