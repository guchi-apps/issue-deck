// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

/** 変更点の取得だけをスタブする（マージ自体はこのテストでは押さない） */
function stubChanges() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ changes: [], commitCount: 0, truncated: false }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PullRequestMergeButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mainへのPRでは確認ダイアログに含まれる変更を出す（#2080）", () => {
    const fetchMock = stubChanges();
    render(<PullRequestMergeButton pullRequest={makePullRequest()} onMerged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("mainへのマージです。マージすると本番デプロイが走ります。")).toBeTruthy();
    expect(screen.getByText("このリリースに含まれる変更")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("develop向けのPRでは出さず、取得もしない", () => {
    const fetchMock = stubChanges();
    render(
      <PullRequestMergeButton
        pullRequest={makePullRequest({
          baseRef: "develop",
          headRef: "issue-2080",
          kind: "issue",
          title: "mainマージ時の確認画面に変更点を表示する",
          ciState: "failure",
        })}
        onMerged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("CIが失敗しています。")).toBeTruthy();
    expect(screen.queryByText("このリリースに含まれる変更")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
