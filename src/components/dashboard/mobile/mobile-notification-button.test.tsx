// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// シートの中身はIssue詳細・画面タブへの遷移にルーターを要求する。jsdomではApp Routerが
// マウントされていないため、遷移だけ差し替える（実行状況のシートと同じ）
const openIssue = vi.fn();
const openPullRequest = vi.fn();
vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue, openPullRequest }),
}));

const selectTab = vi.fn();
const selectQuickView = vi.fn();
vi.mock("@/hooks/use-mobile-screen", () => ({
  useMobileScreen: () => ({ selectTab, selectQuickView }),
}));

const releaseStatusesMock = vi.hoisted(() => ({ current: [] as RepositoryReleaseStatus[] }));
vi.mock("@/hooks/use-repository-release-statuses", () => ({
  useRepositoryReleaseStatuses: () => ({
    data: releaseStatusesMock.current,
    isLoading: false,
    error: null,
    refetch: vi.fn(async () => []),
  }),
}));

import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { NotificationProvider } from "@/components/dashboard/notification-state";
import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

function repository(fullName: string): ConnectedRepository {
  return {
    id: fullName,
    name: fullName.split("/")[1],
    fullName,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function label(name: string) {
  return { name, color: "ffffff", description: null };
}

function renderButton(options: { issues?: Issue[]; pullRequests?: PullRequestSummary[] } = {}) {
  return render(
    <NotificationProvider
      repositories={[repository("guchi-apps/issue-deck")]}
      issues={options.issues ?? []}
      pullRequests={options.pullRequests ?? []}
    >
      <MobileNotificationButton />
    </NotificationProvider>,
  );
}

afterEach(() => {
  releaseStatusesMock.current = [];
  openIssue.mockClear();
  selectTab.mockClear();
  selectQuickView.mockClear();
  cleanup();
});

describe("MobileNotificationButton（#1772）", () => {
  it("対応が必要なものが無ければバッジを出さない（アイコンは残す）", () => {
    const { container } = renderButton();

    expect(screen.getByRole("button", { name: "対応が必要なもの" })).toBeTruthy();
    expect(container.querySelector(".bg-amber-500")).toBeNull();
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  it("件数バッジを出す（判定はPCのベルと同じ）", () => {
    const { container } = renderButton({
      issues: [
        makeIssue({ id: "a", number: 1, labels: [label("00.check-user")] }),
        makeIssue({ id: "b", number: 2, labels: [label("00.check-user")] }),
      ],
    });

    expect(container.querySelector(".bg-amber-500")?.textContent).toBe("2");
  });

  it("手作業待ちはバッジの件数に含めない（#1936。PCのベルと同じ）", () => {
    const { container } = renderButton({
      issues: [
        makeIssue({ id: "a", number: 1, labels: [label("00.check-user")] }),
        makeIssue({ id: "b", number: 2, labels: [label("71.manual-step")] }),
      ],
    });

    expect(container.querySelector(".bg-amber-500")?.textContent).toBe("1");
  });

  it("押すとシートに区分ごとの一覧が出る", () => {
    renderButton({
      issues: [
        makeIssue({
          id: "issue-10",
          number: 10,
          title: "計画を見てほしいIssue",
          labels: [label("00.check-user"), label("01.check-plan")],
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "対応が必要なもの" }));

    expect(screen.getByText("確認待ち")).toBeTruthy();
    expect(screen.getByText("計画の承認")).toBeTruthy();
  });

  it("0件のときは何も無いことを文言で出す", () => {
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "対応が必要なもの" }));

    expect(screen.getByText("いま対応が必要なものはありません")).toBeTruthy();
  });

  it("項目を押すとIssue詳細へ遷移し、シートを閉じる", () => {
    renderButton({
      issues: [
        makeIssue({
          id: "issue-10",
          number: 10,
          title: "計画を見てほしいIssue",
          labels: [label("00.check-user"), label("01.check-plan")],
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "対応が必要なもの" }));
    fireEvent.click(screen.getByText("#10 計画を見てほしいIssue"));

    expect(openIssue).toHaveBeenCalledWith("issue-10");
    expect(screen.queryByText("確認待ち")).toBeNull();
  });

  // PCは`pane`を切り替えれば済むが、スマホは`mscreen`を進めないと画面が変わらない（#1772）
  it("フッターからはスマホの画面遷移で確認待ち一覧・ブランチ画面へ移る", () => {
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "対応が必要なもの" }));
    fireEvent.click(screen.getByText("確認待ちを一覧で見る"));
    expect(selectQuickView).toHaveBeenCalledWith("check-user");

    fireEvent.click(screen.getByRole("button", { name: "対応が必要なもの" }));
    fireEvent.click(screen.getByText("ブランチ画面を開く"));
    expect(selectTab).toHaveBeenCalledWith("flow");
  });
});
