// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  const repositoryFullName = overrides.repositoryFullName ?? "guchi-apps/issue-deck";
  const number = overrides.number ?? 1;
  return {
    id: `${repositoryFullName}#${number}`,
    repositoryFullName,
    repositoryPrivate: false,
    number,
    title: "PRのタイトル",
    htmlUrl: `https://github.com/${repositoryFullName}/pull/${number}`,
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    baseRef: "develop",
    headRef: `issue-${number}`,
    kind: "issue",
    linkedIssueNumber: number,
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

type RenderOverrides = Partial<{
  view: PullRequestViewId;
  isLoading: boolean;
  error: string | null;
  failedRepositories: string[];
  selectedPullRequestId: string | null;
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
}>;

function renderList(pullRequests: PullRequestSummary[], overrides: RenderOverrides = {}) {
  return render(
    <PullRequestList
      view={overrides.view ?? "in-progress"}
      pullRequests={pullRequests}
      failedRepositories={overrides.failedRepositories ?? []}
      fetchedAt="2026-08-11T10:30:00Z"
      isLoading={overrides.isLoading ?? false}
      error={overrides.error ?? null}
      onRefresh={vi.fn()}
      selectedPullRequestId={overrides.selectedPullRequestId ?? null}
      onSelectPullRequest={overrides.onSelectPullRequest}
    />,
  );
}

describe("PullRequestList", () => {
  afterEach(() => {
    cleanup();
  });

  it("PRが無いときはビューに応じた空状態を表示する", () => {
    renderList([]);
    expect(screen.getByText("処理中のPull Requestはありません。")).toBeTruthy();

    cleanup();
    renderList([], { view: "all" });
    expect(screen.getByText("Pull Requestはありません。")).toBeTruthy();
  });

  it("リポジトリごとにグループ化し、件数を表示する", () => {
    renderList([
      makePullRequest({ repositoryFullName: "guchi-apps/issue-deck", number: 1 }),
      makePullRequest({ repositoryFullName: "guchi-apps/dayspan", number: 2, createdAt: "2026-08-02T00:00:00Z" }),
      makePullRequest({ repositoryFullName: "guchi-apps/dayspan", number: 3, createdAt: "2026-08-03T00:00:00Z" }),
    ]);

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "guchi-apps/issue-deck1",
      "guchi-apps/dayspan2",
    ]);
    expect(screen.getByText("3件")).toBeTruthy();
  });

  it("CI通過済みのPRにはマージボタンを出す", () => {
    renderList([makePullRequest({ ciState: "success" })]);
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
    expect(screen.getByText("CI通過")).toBeTruthy();
  });

  it("CI実行中・Auto-merge有効のPRにもマージボタンを出す（#1087）", () => {
    renderList([
      makePullRequest({ number: 1, ciState: "pending" }),
      makePullRequest({ number: 3, autoMergeEnabled: true }),
    ]);
    expect(screen.getAllByRole("button", { name: "マージする" })).toHaveLength(2);
    expect(screen.getByText("CI実行中")).toBeTruthy();
    expect(screen.getByText("Auto-merge有効")).toBeTruthy();
  });

  it("自動でマージされないPRには「ユーザーのマージが必要です」を出す（#1469）", () => {
    renderList([
      // 対応Issueに00.check-userが付いた実装PR
      makePullRequest({ number: 1, linkedIssueCheckUser: true }),
      // develop→mainのリリースPR（常に人がマージする）
      makePullRequest({
        number: 2,
        kind: "release",
        baseRef: "main",
        headRef: "develop",
        linkedIssueNumber: null,
      }),
    ]);
    expect(screen.getAllByText("ユーザーのマージが必要です")).toHaveLength(2);
  });

  it("判定が確定していないPRには出さない（#1469）", () => {
    renderList([makePullRequest({ linkedIssueCheckUser: false })]);
    expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
  });

  it("draftのPRはGitHubがマージを受け付けないためボタンを出さない", () => {
    renderList([makePullRequest({ draft: true })]);
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
    expect(screen.getByText("ドラフト")).toBeTruthy();
  });

  it("そのままマージしてよいか怪しいPRは確認ダイアログを挟む", () => {
    renderList([makePullRequest({ ciState: "failure" })]);
    fireEvent.click(screen.getByRole("button", { name: "マージする" }));
    expect(screen.getByText("このPRをマージしますか？")).toBeTruthy();
    expect(screen.getByText("CIが失敗しています。")).toBeTruthy();
  });

  it("種別・ブランチ・対応Issueへの導線を表示する", () => {
    renderList([
      makePullRequest({
        number: 7,
        kind: "release",
        baseRef: "main",
        headRef: "develop",
        linkedIssueNumber: null,
      }),
    ]);

    expect(screen.getByText("リリース（develop→main）")).toBeTruthy();
    expect(screen.getByText("develop")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.queryByText(/^Issue #/)).toBeNull();
  });

  it("対応Issueが特定できたPRにはIssueへのリンクを出す", () => {
    renderList([makePullRequest({ number: 9, linkedIssueNumber: 1058 })]);
    const link = screen.getByRole("link", { name: "Issue #1058" });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/1058");
  });

  it("取得に失敗したリポジトリがあることを画面に出す", () => {
    renderList([], { failedRepositories: ["guchi-apps/vps"] });
    expect(screen.getByText(/取得できなかったリポジトリがあります: guchi-apps\/vps/)).toBeTruthy();
  });

  it("エラー時はメッセージを表示し、空状態は出さない", () => {
    renderList([], { error: "リクエストに失敗しました (502)" });
    expect(screen.getByText("リクエストに失敗しました (502)")).toBeTruthy();
    expect(screen.queryByText("処理中のPull Requestはありません。")).toBeNull();
  });

  it("PR番号をタイトルの前に表示し、GitHubのPRへのリンクを併記する", () => {
    renderList([makePullRequest({ number: 42, title: "マージ待ちPR一覧を追加する" })]);
    // Issue一覧と同じ「#番号 タイトル」の並び
    const title = screen.getByRole("button", { name: /マージ待ちPR一覧を追加する/ });
    expect(title.textContent?.startsWith("#42 マージ待ちPR一覧を追加する")).toBe(true);
    const link = screen.getByRole("link", { name: "#42 をGitHubで開く" });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/pull/42");
  });

  it("タイトルを押すと選択を親へ通知する（#1087）", () => {
    const onSelectPullRequest = vi.fn();
    renderList([makePullRequest({ number: 42, title: "PR詳細を追加する" })], {
      onSelectPullRequest,
    });

    fireEvent.click(screen.getByRole("button", { name: /#42 PR詳細を追加する/ }));
    expect(onSelectPullRequest).toHaveBeenCalledTimes(1);
    expect(onSelectPullRequest.mock.calls[0][0].number).toBe(42);
  });

  it("選択中のPRは一覧側でも見分けられるようにする", () => {
    renderList([makePullRequest({ number: 42 }), makePullRequest({ number: 43 })], {
      selectedPullRequestId: "guchi-apps/issue-deck#43",
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows[0].className).not.toContain("border-l-primary");
    expect(rows[1].className).toContain("border-l-primary");
  });
});
