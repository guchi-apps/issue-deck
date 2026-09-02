// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMergeChanges } from "@/components/dashboard/pull-request-merge-changes";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestChange, PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#2075",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 2075,
    title: "v4.19.0をmainへリリースする",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/2075",
    authorLogin: "guchi",
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
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeChange(overrides: Partial<PullRequestChange> = {}): PullRequestChange {
  return {
    id: "a1",
    pullRequestNumber: 2077,
    issueNumber: 2062,
    title: "自動マージ失敗時の理由表示機能の追加",
    kind: "issue",
    ...overrides,
  };
}

function mockChanges(
  changes: PullRequestChange[],
  { commitCount = changes.length, truncated = false } = {},
) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return { ok: true, json: async () => ({ changes, commitCount, truncated }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requestedUrls };
}

describe("PullRequestMergeChanges", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("開いているあいだに取得し、対応Issueの番号とタイトルを並べる", async () => {
    const { requestedUrls } = mockChanges([
      makeChange(),
      makeChange({
        id: "a2",
        pullRequestNumber: 2074,
        issueNumber: null,
        kind: "version-bump",
        title: "v4.19.0をリリースする",
      }),
    ]);

    render(<PullRequestMergeChanges pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("自動マージ失敗時の理由表示機能の追加")).toBeTruthy();
    expect(screen.getByText("#2062")).toBeTruthy();
    // 対応Issueが取れないバンプPRはPR番号で出し、利用者向けの変更ではない印を添える
    expect(screen.getByText("#2074")).toBeTruthy();
    expect(screen.getByText("バンプ")).toBeTruthy();
    expect(requestedUrls[0]).toContain(
      "/api/pull-requests/changes?owner=guchi-apps&repo=issue-deck&number=2075",
    );
  });

  it("PRのタイトルから版を出す", async () => {
    mockChanges([makeChange()]);

    render(<PullRequestMergeChanges pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("v4.19.0")).toBeTruthy();
  });

  it("閉じているあいだは取りに行かない", () => {
    const { fetchMock } = mockChanges([makeChange()]);

    render(<PullRequestMergeChanges pullRequest={makePullRequest()} open={false} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("取得に失敗しても、理由とGitHubへの導線だけを出す（マージは止めない）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: "github_api_error", message: "GitHubへ接続できませんでした" }),
      })),
    );

    render(<PullRequestMergeChanges pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("変更点を取得できませんでした。")).toBeTruthy();
    expect(screen.getByText("GitHubへ接続できませんでした")).toBeTruthy();
    expect(screen.getByRole("link", { name: /GitHubで差分を見る/ })).toBeTruthy();
  });

  it("打ち切ったときは一部である旨を出す", async () => {
    mockChanges([makeChange()], { commitCount: 100, truncated: true });

    render(<PullRequestMergeChanges pullRequest={makePullRequest()} open />);

    await waitFor(() =>
      expect(screen.getByText("コミットが多いため一部だけを出しています")).toBeTruthy(),
    );
    expect(screen.getByText(/100件以上/)).toBeTruthy();
  });
});
