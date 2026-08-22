// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MergePendingPullRequests } from "@/components/dashboard/merge-pending-pull-requests";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

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

afterEach(() => {
  cleanup();
});

describe("MergePendingPullRequestsの「更新」（#2175）", () => {
  it("`onRefresh`を渡された画面だけにボタンが出て、押すと取り直す", () => {
    // 一覧を指で引っ張れないPC向けの導線。スマホは引っ張って更新が同じ取り直しを呼ぶ
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[makePullRequest()]}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("`onRefresh`が無ければボタンを出さない", () => {
    render(
      <MergePendingPullRequests pullRequests={[makePullRequest()]} onSelectPullRequest={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("押せるPRが無く完了待ちだけのときも取り直せる", () => {
    // CIが終わったかどうかを確かめたいのはむしろこの状態のため、薄い1行に落としても残す
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[]}
        waitingForChecksCount={2}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText(/CI・判定の完了待ちが2件あります/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("取り直している間はボタンを押せない", () => {
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[makePullRequest()]}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
        isRefreshing
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
