// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationButton } from "@/components/dashboard/notification-button";
import { NotificationProvider } from "@/components/dashboard/notification-state";
import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

const releaseStatusesMock = vi.hoisted(() => ({ current: [] as RepositoryReleaseStatus[] }));
/** `useRepositoryReleaseStatuses`へ渡された`enabled`を記録する（#1727の判定を検査するため） */
const releaseStatusesEnabled = vi.hoisted(() => ({ calls: [] as boolean[] }));

vi.mock("@/hooks/use-repository-release-statuses", () => ({
  useRepositoryReleaseStatuses: (enabled: boolean) => {
    releaseStatusesEnabled.calls.push(enabled);
    return {
      data: releaseStatusesMock.current,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

function repository(
  fullName: string,
  overrides: Partial<ConnectedRepository> = {},
): ConnectedRepository {
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
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
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

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#100",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 100,
    title: "PRのタイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/100",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-100",
    kind: "issue",
    linkedIssueNumber: null,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeable: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

type RenderOptions = {
  repositories?: ConnectedRepository[];
  issues?: Issue[];
  pullRequests?: PullRequestSummary[];
  onOpenTarget?: () => void;
  onOpenCheckUserView?: () => void;
  onOpenFlow?: () => void;
};

/** 材料はProviderが配る（#1772）ので、ボタン単体ではなくProviderごと描く */
function renderButton(options: RenderOptions = {}) {
  return render(
    <NotificationProvider
      repositories={options.repositories ?? [repository("guchi-apps/issue-deck")]}
      issues={options.issues ?? []}
      pullRequests={options.pullRequests ?? []}
    >
      <NotificationButton
        onOpenTarget={options.onOpenTarget ?? (() => {})}
        onOpenCheckUserView={options.onOpenCheckUserView ?? (() => {})}
        onOpenFlow={options.onOpenFlow ?? (() => {})}
      />
    </NotificationProvider>,
  );
}

afterEach(() => {
  releaseStatusesMock.current = [];
  releaseStatusesEnabled.calls = [];
  cleanup();
});

describe("NotificationButton リリース状況の取得条件", () => {
  it("claude-issue-dispatch.ymlを持たないリポジトリしか無くても取得する（#1727）", () => {
    renderButton({ repositories: [repository("guchi-apps/vps", { hasClaudeWorkflow: false })] });

    // 無人実行の有無とリリースフローの有無は別軸で、リリースフローだけを載せたリポジトリが
    // ある。対象の絞り込みはAPI側（`release-develop-to-main.yml`の実在）に任せる。
    expect(releaseStatusesEnabled.calls).toContain(true);
    expect(releaseStatusesEnabled.calls).not.toContain(false);
  });

  it("連携リポジトリが1件も無ければ取得しない", () => {
    renderButton({ repositories: [] });

    expect(releaseStatusesEnabled.calls).not.toContain(true);
  });
});

describe("NotificationButton バッジ", () => {
  it("対応が必要なものが無ければバッジを出さない（アイコンは残す）", () => {
    const { container } = renderButton();

    expect(screen.getByLabelText("対応が必要なもの")).toBeTruthy();
    expect(container.querySelector(".bg-amber-500")).toBeNull();
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  it("件数を出し、失敗が混ざっていなければamberにする", () => {
    const { container } = renderButton({
      issues: [
        makeIssue({ id: "a", number: 1, labels: [label("00.check-user")] }),
        makeIssue({ id: "b", number: 2, labels: [label("71.manual-step")] }),
      ],
    });

    expect(container.querySelector(".bg-amber-500")?.textContent).toBe("2");
  });

  it("失敗が1件でもあればバッジを赤にする（#1059と同じ考え方）", () => {
    const { container } = renderButton({
      issues: [makeIssue({ labels: [label("00.check-user")] })],
      pullRequests: [makePullRequest({ ciState: "failure" })],
    });

    expect(container.querySelector(".bg-destructive")?.textContent).toBe("2");
    expect(container.querySelector(".bg-amber-500")).toBeNull();
  });
});

describe("NotificationButton ポップオーバー", () => {
  it("区分ごとに見出しを付けて並べ、項目を押すと遷移先を渡して閉じる", () => {
    const onOpenTarget = vi.fn();
    renderButton({
      issues: [
        makeIssue({
          id: "issue-10",
          number: 10,
          title: "計画を見てほしいIssue",
          labels: [label("00.check-user"), label("01.check-plan")],
        }),
      ],
      onOpenTarget,
    });

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));

    expect(screen.getByText("確認待ち")).toBeTruthy();
    expect(screen.getByText("計画の承認")).toBeTruthy();

    fireEvent.click(screen.getByText("#10 計画を見てほしいIssue"));

    expect(onOpenTarget).toHaveBeenCalledWith({ kind: "issue", issueId: "issue-10" });
  });

  it("0件のときは何も無いことを文言で出す", () => {
    renderButton();

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));

    expect(screen.getByText("いま対応が必要なものはありません")).toBeTruthy();
  });

  it("フッターから確認待ち一覧・ブランチ画面へ移れる", () => {
    const onOpenCheckUserView = vi.fn();
    const onOpenFlow = vi.fn();
    renderButton({ onOpenCheckUserView, onOpenFlow });

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));
    fireEvent.click(screen.getByText("確認待ちを一覧で見る"));
    expect(onOpenCheckUserView).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));
    fireEvent.click(screen.getByText("ブランチ画面を開く"));
    expect(onOpenFlow).toHaveBeenCalled();
  });
});
