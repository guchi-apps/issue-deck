// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMergeProduction } from "@/components/dashboard/pull-request-merge-production";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestChange, PullRequestSummary } from "@/types/pull-request";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

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
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
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
  { commitCount = changes.length, truncated = false, previousVersion = null as string | null } = {},
) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return { ok: true, json: async () => ({ changes, commitCount, truncated, previousVersion }) };
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
    // バージョンバンプのPRは行に出さず、PR件数にも数えない（#3260）
    expect(screen.queryByText("#2074")).toBeNull();
    expect(screen.queryByText("v4.19.0をリリースする")).toBeNull();
    expect(screen.queryByText("バンプ")).toBeNull();
    expect(screen.getByText(/PR 1件/)).toBeTruthy();
    expect(requestedUrls[0]).toContain(
      "/api/pull-requests/changes?owner=guchi-apps&repo=issue-deck&number=2075",
    );
  });

  it("各行にレビュー状態の丸を付け、押すとダイアログを閉じてPR詳細を開く（#3904）", async () => {
    mockChanges([
      makeChange({ id: "a1", pullRequestNumber: 2077, title: "要修正のPR" }),
      makeChange({ id: "a2", pullRequestNumber: 2078, issueNumber: 2063, title: "問題なしのPR" }),
      makeChange({ id: "a3", pullRequestNumber: null, issueNumber: null, kind: "commit", title: "番号なしの変更" }),
    ]);
    const onNavigate = vi.fn();
    const row = (issueNumber: number, pullRequestNumber: number, reviewKind: string) => ({
      issueNumber,
      pullRequestNumber,
      reviewKind,
      reviewLabel: reviewKind,
    });

    render(
      <PullRequestMergeProduction
        pullRequest={makePullRequest({
          releaseVerification: {
            rows: [row(2062, 2077, "changes-requested"), row(2063, 2078, "ok")],
          } as unknown as PullRequestSummary["releaseVerification"],
        })}
        open
        onNavigate={onNavigate}
      />,
    );

    const button = (await screen.findByText("要修正のPR")).closest("button");
    expect(button?.textContent).toContain("要修正");
    expect(screen.getByText("問題なしのPR").closest("button")?.textContent).not.toContain("要");
    expect(screen.getByRole("img", { name: "AIレビュー: 要修正" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "AIレビュー: 問題なし" }).className).toContain(
      "bg-green-600",
    );
    // 判定表にない変更も、未確認であることを灰色の丸から読める
    expect(screen.getByRole("img", { name: "AIレビュー: 記録なし" })).toBeTruthy();
    // PR番号が取れない行は押せない
    expect(screen.getByText("番号なしの変更").closest("button")).toBeNull();

    fireEvent.click(button as HTMLElement);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("どの版からどの版へ上げるかを、変更一覧とは別に出す（#3260）", async () => {
    mockChanges([makeChange()], { previousVersion: "4.18.2" });

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("v4.18.2")).toBeTruthy();
    expect(screen.getByText("v4.19.0")).toBeTruthy();
    // 版は「このリリースに含まれる変更」の見出しには載せない
    const heading = screen.getByText("このリリースに含まれる変更").parentElement;
    expect(heading?.textContent).not.toContain("v4.19.0");
  });

  it("前の版が読めないときは、新しい版だけを出し、エラーにしない（#3260）", async () => {
    mockChanges([makeChange()], { previousVersion: null });

    render(<PullRequestMergeProduction pullRequest={makePullRequest()} open />);

    expect(await screen.findByText("自動マージ失敗時の理由表示機能の追加")).toBeTruthy();
    expect(screen.getByText("v4.19.0")).toBeTruthy();
    expect(screen.queryByText("→")).toBeNull();
    expect(screen.queryByText("変更点を取得できませんでした。")).toBeNull();
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
                acknowledgement: null,
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
                acknowledgement: null,
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
    // 一覧の各行には状態の丸を付け、問題なしの判定文は並べない（#3904）
    expect(screen.queryByText("問題なし（LGTM）")).toBeNull();
    expect(screen.getByRole("img", { name: "AIレビュー: 要修正" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "AIレビュー: 問題なし" })).toBeTruthy();
    expect(
      screen.getByText("自動マージ失敗時の理由表示機能の追加").closest("button")?.textContent,
    ).toContain("要修正");
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

  it("凍結ブランチのリリースPRでは、3区分とCI・コンフリクトを「リリースの検証」1枚にまとめる（#4277）", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith("/api/repositories/release/verification")) {
          const section = (kind: string, state: string) => ({
            kind, state, reason: null, summary: null, evidenceUrl: null, agent: null, updatedAt: null,
            findings: [], affectedPullRequests: [], affectedFiles: [], reviewedFiles: null, totalFiles: null, progress: null,
          });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              verification: {
                enforced: false,
                gateStatus: "blocked",
                blockers: [],
                integration: section("integration", "passed"),
                aiReview: section("ai_review", "not_run"),
                aiReviewAssignee: "Codex · gpt-6-sol",
                target: { baseSha: "b".repeat(40), headSha: "a".repeat(40) },
              },
            }),
          };
        }
        if (url.startsWith("/api/repositories/release/fix-series")) {
          return { ok: true, status: 200, json: async () => ({ series: [] }) };
        }
        if (url.startsWith("/api/repositories/release/changes")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pullRequests: [
                {
                  number: 2077, title: "要修正のPR", issueNumber: 2062, isVersionBump: false, prHeadSha: null, reviewUnavailable: false,
                  review: { reviewKind: "changes-requested", reviewLabel: "要修正", riskKind: "unknown", riskLabel: "", riskReasons: [], confirmLabel: null, reviewedSha: null },
                },
              ],
              unknownCommits: [],
              source: "release-pr",
              headSha: null,
              truncated: false,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ changes: [makeChange({ title: "要修正のPR" })], commitCount: 1, truncated: false, previousVersion: "4.18.0" }),
        };
      }),
    );

    render(
      <PullRequestMergeProduction
        pullRequest={makePullRequest({ headRef: "release-main/v4.19.0", ciState: "success", mergeable: true })}
        open
      />,
    );

    expect(await screen.findByText("リリースの検証")).toBeTruthy();
    expect(await screen.findByText("要修正 1")).toBeTruthy();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["全体レビュー", "統合検証", "個別PRレビュー", "CI・コンフリクト"]);
    // 実際の担当が決まる前は「担当予定」。未実施を問題なしにしない
    expect(screen.getByText("担当予定: Codex · gpt-6-sol")).toBeTruthy();
    // 全体レビュー区分と、各PR行の「全体〔共通〕」の両方が同じ「未実施」を出す（#4305）
    expect(screen.getAllByText("未実施").length).toBeGreaterThan(0);
    // 旧「マージ前の確認」の枠と「Claudeのレビュー」行は出さない（個別PRレビューへ統合）
    expect(screen.queryByText("マージ前の確認")).toBeNull();
    expect(screen.queryByText("Claudeのレビュー")).toBeNull();
    expect(within(screen.getByTestId("merge-precheck-inline")).getByText("成功")).toBeTruthy();
    // 変更一覧は個別PRレビューを開いた中にあり、判定は区分と同じ取得から引く
    // 各PR行の5チェック（#4305）。旧来の丸は、コードのチェックが引き継ぐ
    expect(screen.getByRole("button", { name: "コードレビュー（このPRのAIレビュー）: 要修正" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^全体レビュー（リリース全体の共通結果）/ }).length).toBeGreaterThan(0);
    expect(requestedUrls.some((u) => u.includes("include=merge-checks"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("/api/repositories/release/verification?owner=guchi-apps&repo=issue-deck&pullRequest=2075"))).toBe(true);
  });
});

