// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { OpenPullRequest } from "@/types/pull-request";

function makePullRequest(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
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
    baseRef: "develop",
    headRef: `issue-${number}`,
    kind: "issue",
    linkedIssueNumber: number,
    autoMergeEnabled: false,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function renderList(pullRequests: OpenPullRequest[], overrides: Partial<{ isLoading: boolean; error: string | null; failedRepositories: string[] }> = {}) {
  return render(
    <PullRequestList
      pullRequests={pullRequests}
      failedRepositories={overrides.failedRepositories ?? []}
      fetchedAt="2026-08-11T10:30:00Z"
      isLoading={overrides.isLoading ?? false}
      error={overrides.error ?? null}
      onRefresh={vi.fn()}
    />,
  );
}

describe("PullRequestList", () => {
  afterEach(() => {
    cleanup();
  });

  it("PRが無いときは空状態を表示する", () => {
    renderList([]);
    expect(screen.getByText("マージ待ちのPull Requestはありません。")).toBeTruthy();
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

  it("CI実行中・draft・Auto-merge有効のPRにはマージボタンを出さない", () => {
    renderList([
      makePullRequest({ number: 1, ciState: "pending" }),
      makePullRequest({ number: 2, draft: true }),
      makePullRequest({ number: 3, autoMergeEnabled: true }),
    ]);
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
    expect(screen.getByText("CI実行中")).toBeTruthy();
    expect(screen.getByText("ドラフト")).toBeTruthy();
    expect(screen.getByText("Auto-merge有効")).toBeTruthy();
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
    expect(screen.queryByText("マージ待ちのPull Requestはありません。")).toBeNull();
  });

  it("PRのタイトルはGitHubのPRへのリンクになっている", () => {
    renderList([makePullRequest({ number: 42, title: "マージ待ちPR一覧を追加する" })]);
    const list = screen.getByRole("list");
    const link = within(list).getByRole("link", { name: /マージ待ちPR一覧を追加する/ });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/pull/42");
  });
});
