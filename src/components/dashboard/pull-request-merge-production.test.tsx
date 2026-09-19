// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMergeProduction } from "@/components/dashboard/pull-request-merge-production";
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
    reviewVerdict: null,
    releaseVerification: null,
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

describe("PullRequestMergeProduction", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("開いているあいだに取得し、PR番号とタイトルを並べる", async () => {
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

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("自動マージ失敗時の理由表示機能の追加")).toBeTruthy();
    // 行頭はPR番号で、対応Issue番号は行の中に添える（#2843）
    expect(screen.getByText("#2077")).toBeTruthy();
    expect(screen.getByText("Issue #2062")).toBeTruthy();
    // 対応Issueが取れないバンプPRは番号だけを出し、利用者向けの変更ではない印を添える
    expect(screen.getByText("#2074")).toBeTruthy();
    expect(screen.getByText("バンプ")).toBeTruthy();
    expect(requestedUrls[0]).toContain(
      "/api/pull-requests/changes?owner=guchi-apps&repo=issue-deck&number=2075",
    );
  });

  it("レビュー結果は「マージ前の確認」の1行に集約し、含まれる変更の行には出さない（#3093）", async () => {
    mockChanges([
      makeChange(),
      makeChange({ id: "a2", pullRequestNumber: 2078, issueNumber: 2063, title: "別の変更" }),
    ]);

    render(
      <PullRequestMergeProduction
        pullRequest={makePullRequest({
          releaseVerification: {
            rows: [
              {
                issueNumber: 2062,
                issueTitle: null,
                pullRequestNumber: 2077,
                reviewKind: "changes-requested",
                reviewLabel: "要修正",
                riskKind: "none",
                riskLabel: "該当なし",
                reviewBody: null,
              },
              {
                issueNumber: 2063,
                issueTitle: null,
                pullRequestNumber: 2078,
                reviewKind: "ok",
                reviewLabel: "問題なし（LGTM）",
                riskKind: "none",
                riskLabel: "該当なし",
                reviewBody: null,
              },
            ],
            tally: { total: 2, ok: 1, needsCheck: 0, changesRequested: 1, skipped: 0, unknown: 0 },
          },
        })}
        open
      />,
    );

    // 集計と、要修正のPRが「マージ前の確認」に出る
    expect(await screen.findByText("要修正 1 ／ 問題なし 1")).toBeTruthy();
    expect(screen.getByText("#2077が要修正")).toBeTruthy();
    expect(screen.getByText("止めるべき項目があります（1件）")).toBeTruthy();
    // 一覧の行には判定を並べない（何のPRが入るかだけを読む場所）
    expect(screen.queryByText("問題なし（LGTM）")).toBeNull();
    expect(screen.queryByText("要修正")).toBeNull();
    expect(screen.getByText("自動マージ失敗時の理由表示機能の追加")).toBeTruthy();
    expect(screen.getByText("別の変更")).toBeTruthy();
  });

  it("判定の記録が無いリリースは、レビューの行を灰色にして総合判定を「確認が必要」にしない", async () => {
    mockChanges([makeChange()]);

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("自動レビューの記録がありません")).toBeTruthy();
    expect(screen.getByText("確認できた2項目に問題はありません")).toBeTruthy();
  });

  it("CIとコンフリクトの状態を「マージ前の確認」に出す", async () => {
    mockChanges([makeChange()]);

    render(
      <PullRequestMergeProduction
        pullRequest={makePullRequest({ ciState: "failure", mergeable: false })}
        open
      />,
    );

    expect(await screen.findByText("止めるべき項目があります（2件）")).toBeTruthy();
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(screen.getByText("あり")).toBeTruthy();
  });

  it("PRのタイトルから版を出す", async () => {
    mockChanges([makeChange()]);

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("v4.19.0")).toBeTruthy();
  });

  it("閉じているあいだは取りに行かない", () => {
    const { fetchMock } = mockChanges([makeChange()]);

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open={false} />);

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

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("変更点を取得できませんでした。")).toBeTruthy();
    expect(screen.getByText("GitHubへ接続できませんでした")).toBeTruthy();
    // 取得できなくても「マージ前の確認」は出し、レビューの行だけ灰色にする（マージは止めない）
    expect(screen.getByText("マージ前の確認")).toBeTruthy();
    expect(screen.getByText("確認できません")).toBeTruthy();
    expect(screen.getByRole("link", { name: /GitHubで差分を見る/ })).toBeTruthy();
  });

  it("打ち切ったときは一部である旨を出す", async () => {
    mockChanges([makeChange()], { commitCount: 100, truncated: true });

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    await waitFor(() =>
      expect(screen.getByText("コミットが多いため一部だけを出しています")).toBeTruthy(),
    );
    expect(screen.getByText(/100件以上/)).toBeTruthy();
  });
});
