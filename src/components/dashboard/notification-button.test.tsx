// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
/** リリース状況の取り直し（#1909の自動更新・更新ボタンが呼ぶ）。同一性を保つため外に置く */
const releaseStatusesRefetch = vi.hoisted(() => vi.fn(async () => [] as RepositoryReleaseStatus[]));

vi.mock("@/hooks/use-repository-release-statuses", () => ({
  useRepositoryReleaseStatuses: (enabled: boolean) => {
    releaseStatusesEnabled.calls.push(enabled);
    return {
      data: releaseStatusesMock.current,
      isLoading: false,
      error: null,
      refetch: releaseStatusesRefetch,
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

/** Issue一覧・PR一覧の取り直し（`IssueDeckShell`が渡すもの。#1909） */
const refreshIssuesMock = vi.fn(async () => true);
const refreshPullRequestsMock = vi.fn();

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
      onRefreshIssues={refreshIssuesMock}
      onRefreshPullRequests={refreshPullRequestsMock}
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
  releaseStatusesRefetch.mockClear();
  refreshIssuesMock.mockClear();
  refreshPullRequestsMock.mockClear();
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
        makeIssue({ id: "b", number: 2, labels: [label("00.check-user")] }),
      ],
    });

    expect(container.querySelector(".bg-amber-500")?.textContent).toBe("2");
  });

  it("手作業待ちはバッジの件数に含めない（#1936）", () => {
    const { container } = renderButton({
      issues: [
        makeIssue({ id: "a", number: 1, labels: [label("00.check-user")] }),
        makeIssue({ id: "b", number: 2, labels: [label("71.manual-step")] }),
      ],
    });

    expect(container.querySelector(".bg-amber-500")?.textContent).toBe("1");
  });

  it("手作業待ちしか無ければバッジを出さない（#1936）", () => {
    const { container } = renderButton({
      issues: [makeIssue({ id: "b", number: 2, labels: [label("71.manual-step")] })],
    });

    expect(container.querySelector(".bg-amber-500")).toBeNull();
    expect(container.querySelector(".bg-destructive")).toBeNull();
    expect(screen.getByLabelText("対応が必要なもの").getAttribute("title")).toBe(
      "対応が必要なもの",
    );
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

  it("手作業待ちは一覧には残し、見出しの件数で内訳を出す（#1936）", () => {
    renderButton({
      issues: [
        makeIssue({ id: "a", number: 1, labels: [label("00.check-user")] }),
        makeIssue({
          id: "b",
          number: 2,
          title: "VPSの.envを直す",
          labels: [label("71.manual-step")],
        }),
      ],
    });

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));

    // バッジは1件だが、一覧には手作業待ちも並ぶ。その差は見出しの内訳で読める
    expect(screen.getByText("1件・手作業待ち1件")).toBeTruthy();
    expect(screen.getByText("手作業待ち")).toBeTruthy();
    expect(screen.getByText("#2 VPSの.envを直す")).toBeTruthy();
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

/**
 * #1909。開いている間は30秒ごとに取り直し、右上の更新ボタンでいつ時点の内容かを出す。
 *
 * 取り直すのはベルの材料3つ（リリース状況・Issue一覧・Pull Request一覧）で、**開いている間
 * だけ**。閉じている間の取得が増えていないことも併せて確かめる。
 */
describe("NotificationButton 自動更新", () => {
  it("閉じている間は取りに行かず、開いた時点で3つとも取り直す", async () => {
    renderButton();

    expect(releaseStatusesRefetch).not.toHaveBeenCalled();
    expect(refreshIssuesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));

    expect(screen.getByLabelText("対応が必要なものを今すぐ更新")).toBeTruthy();
    await waitFor(() => {
      expect(releaseStatusesRefetch).toHaveBeenCalledTimes(1);
      expect(refreshIssuesMock).toHaveBeenCalledTimes(1);
      expect(refreshPullRequestsMock).toHaveBeenCalledTimes(1);
    });
  });

  it("更新ボタンを押すと、次の周期を待たずに取り直す", async () => {
    renderButton();

    fireEvent.click(screen.getByLabelText("対応が必要なもの"));

    // 取得が終わって「いつ時点か」が出るまで待つ（取得中の重複呼び出しは弾かれるため）
    await waitFor(
      () => expect(screen.getByLabelText("対応が必要なものを今すぐ更新").textContent).toContain("30秒ごと"),
      { timeout: 3_000 },
    );

    fireEvent.click(screen.getByLabelText("対応が必要なものを今すぐ更新"));

    await waitFor(() => {
      expect(releaseStatusesRefetch).toHaveBeenCalledTimes(2);
      expect(refreshIssuesMock).toHaveBeenCalledTimes(2);
    });
  });
});
