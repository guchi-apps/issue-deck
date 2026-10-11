// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReleasePullRequestOverview } from "@/components/dashboard/release-pull-request-overview";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { PullRequestSummary } from "@/types/pull-request";

const section = (state: string, findings: unknown[] = []) =>
  ({ kind: "x", state, reason: null, summary: null, evidenceUrl: null, agent: null, updatedAt: null, findings, affectedPullRequests: [], affectedFiles: [], reviewedFiles: null, totalFiles: null, progress: null, diagnostic: null }) as never;

function makeVerification(aiReview = section("passed"), integration = section("passed")): ReleaseVerificationSummary {
  return {
    enforced: true,
    gateStatus: "ready",
    blockers: [],
    integration,
    aiReview,
    mac: { state: "not_applicable", reason: null, summary: null, evidenceUrl: null, updatedAt: null },
    aiReviewAssignee: "x",
    target: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  } as unknown as ReleaseVerificationSummary;
}

let verification: ReleaseVerificationSummary | null = makeVerification();

vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue: vi.fn(), openPullRequest: vi.fn() }),
}));
vi.mock("@/hooks/use-release-verification", () => ({
  useReleaseVerification: () => ({ verification, error: null }),
}));
vi.mock("@/hooks/use-release-changes", () => ({
  useReleaseChanges: () => ({
    data: { pullRequests: [{ number: 760, title: "並び替え", issueNumber: null, isVersionBump: false, review: null, prHeadSha: null, reviewUnavailable: false }], unknownCommits: [], source: "release-pr", headSha: null, truncated: false },
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/hooks/use-release-candidates", () => ({
  useReleaseCandidates: () => ({
    status: "loaded",
    candidates: [
      { number: 768, title: "v4.41.1", headRef: "release-main/v4.41.1", baseSha: "a".repeat(40), headSha: "b".repeat(40), pullRequestNumbers: [760], verification },
    ],
  }),
}));

function makePullRequest(): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/kurashio#768",
    repositoryFullName: "guchi-apps/kurashio",
    repositoryPrivate: false,
    number: 768,
    title: "v4.41.1をmainへリリースする",
    htmlUrl: "https://github.com/guchi-apps/kurashio/pull/768",
    authorLogin: "github-actions",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "main",
    headRef: "release-main/v4.41.1",
    headSha: "b".repeat(40),
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
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
}

const seriesRow = {
  id: "s1", status: "rebuilding", statusLabel: "修正を反映中", active: true, stepIndex: 4, sourceKind: "review_finding", causeClass: "code",
  itemTitles: ["指摘A"], releasePrNumber: 768, originBaseSha: "c".repeat(40), originHeadSha: "d".repeat(40), issueNumber: 764,
  fixPrNumber: 765, successorPrNumber: null, successorBaseSha: null, successorHeadSha: null, generation: 1, parentId: null,
  stopReason: null, rebuildFailed: false, startState: "none", createdAt: "2026-10-11T00:00:00.000Z",
};

function stubSeries(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("fix-series") ? { series: rows } : { episodes: [] }), { status: 200 }),
    ),
  );
}

describe("ReleasePullRequestOverview（#4428）", () => {
  beforeEach(() => {
    verification = makeVerification();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("修正の無い通常リリースが通過していれば「公開操作待ち」と「本番公開へ進む」を出し、工程は出さない", async () => {
    stubSeries([]);
    render(<ReleasePullRequestOverview pullRequest={makePullRequest()} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-fix-summary").textContent).toContain("公開操作待ち"));
    expect(screen.getByText("本番公開へ進む")).toBeTruthy();
    expect(screen.queryByTestId("release-fix-phases")).toBeNull();
    expect(screen.queryByTestId("release-fix-auto")).toBeNull();
    // 正式タイトルは本文側に全文で出す
    expect(screen.getByRole("heading", { name: "v4.41.1をmainへリリースする" })).toBeTruthy();
    // 並び: 状態 → 検証 → 今回の変更
    const sections = screen.getAllByRole("region").map((el) => el.getAttribute("aria-label"));
    expect(sections.slice(0, 3)).toEqual(["現在の状態と次の操作", "現在候補の検証", "今回リリースする変更"]);
    // 6チェックはこのPR自身を候補として読む
    expect(screen.getByTestId("release-candidate-checks").textContent).toContain("候補PR #768");
  });

  it("修正の取り込み中は操作不要と工程を出し、旧候補の結果を現在の検証として出さない", async () => {
    stubSeries([seriesRow]);
    render(<ReleasePullRequestOverview pullRequest={makePullRequest()} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-fix-summary").textContent).toContain("修正取り込み準備中"));
    expect(screen.getByTestId("release-fix-auto")).toBeTruthy();
    const current = screen.getByTestId("release-fix-phases").querySelector('[aria-current="step"]');
    expect(current?.textContent).toBe("取り込み");
    expect(screen.queryByText("本番公開へ進む")).toBeNull();
    expect(screen.queryByTestId("release-candidate-checks")).toBeNull();
    expect(screen.getByText(/修正を反映したリリース候補はまだできていません/)).toBeTruthy();
  });

  it("指摘があるときは修正Issueの作成を主操作にし、公開の操作を出さない", async () => {
    verification = makeVerification(section("needs_check", [{ title: "a", severity: "medium" }]));
    stubSeries([]);
    render(<ReleasePullRequestOverview pullRequest={makePullRequest()} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-fix-summary").textContent).toContain("修正が必要"));
    expect(screen.getByTestId("release-fix-primary-action").textContent).toContain("修正Issueを作成");
    expect(screen.queryByText("本番公開へ進む")).toBeNull();
    expect(screen.queryByTestId("release-fix-auto")).toBeNull();
  });
});
