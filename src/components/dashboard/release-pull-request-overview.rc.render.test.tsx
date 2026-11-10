// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RcOverviewWithFinalization } from "@/hooks/use-release-rc";
import { PENDING_CONFLICT_PUBLISH_NOTE, ReleasePullRequestOverview } from "@/components/dashboard/release-pull-request-overview";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { PullRequestSummary } from "@/types/pull-request";

const section = (state: string, findings: unknown[] = []) =>
  ({ kind: "x", state, reason: null, summary: null, evidenceUrl: null, agent: null, updatedAt: null, findings, suggestions: [], counterpartNotes: [], review: null, affectedPullRequests: [], affectedFiles: [], reviewedFiles: null, totalFiles: null, progress: null, diagnostic: null }) as never;

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
let rcOverview: RcOverviewWithFinalization | null = null;

vi.mock("@/hooks/use-release-rc", () => ({
  useReleaseRc: () => ({ overview: rcOverview, error: null, reload: vi.fn() }),
}));

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
      { number: 768, title: "v4.41.1", headRef: "release-rc/12", baseSha: "a".repeat(40), headSha: "b".repeat(40), pullRequestNumbers: [760], verification },
    ],
  }),
}));

function makePullRequest(draft = true): PullRequestSummary {
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
    draft,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "main",
    headRef: "release-rc/12",
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
  itemTitles: ["指摘A"], releasePrNumber: 768, originBaseSha: "c".repeat(40), originHeadSha: "b".repeat(40), issueNumber: 764,
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


const candidate = (phase: string, status: string) =>
  ({
    id: "c1", sequence: 12, label: "RC-12", branch: "release-rc/12", phase,
    status: { status, label: status, reason: "", attention: null },
    frozenDevelopSha: "a".repeat(40), frozenPrs: [], approvedExtraPrs: [], currentRevision: 3, prNumber: 768, revisions: [],
    migratedFromPrNumber: null, cancelReason: null, cancelledAt: null, createdAt: "2026-10-12T00:00:00Z", finalizeContract: null,
  }) as never;

const finalization = () =>
  ({
    caller: { supported: true, reasonLabel: null }, mainVersion: "1.0.0", checks: null, history: [],
    current: { id: "f1", status: "applied", statusLabel: "バンプ済み", revision: 3, prNumber: 768, preBaseSha: "a".repeat(40), preHeadSha: "c".repeat(40),
      finalBaseSha: "a".repeat(40), finalHeadSha: "b".repeat(40), version: "1.1.0", versionReservation: "reserved", bumpKind: "minor", bumpKindSource: "auto",
      evidence: [], files: [], runUrl: null, failureReason: null, createdAt: "2026-10-12T00:00:00Z", appliedAt: "2026-10-12T00:01:00Z" },
  }) as never;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("fix-series") ? { series: [] } : { episodes: [] }), { status: 200 })),
  );
}

describe("ReleasePullRequestOverview の新方式候補の工程（#4635）", () => {
  beforeEach(() => {
    verification = makeVerification();
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("合格してもドラフト・公開準備前は「本番公開へ進む」を出さず、公開準備へ案内する", async () => {
    rcOverview = { caller: { supported: true, reasonLabel: null } as never, candidate: candidate("review", "ready_to_prepare"), legacy: null };
    render(<ReleasePullRequestOverview pullRequest={makePullRequest(true)} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-pull-request-journey")).toBeTruthy());
    // 状態の見出しは工程の「いま・担当・次」が持つので、要約帯には重ねない（#5290）
    expect(screen.queryByTestId("release-fix-headline")).toBeNull();
    expect(screen.queryByText("本番公開へ進む")).toBeNull();
    expect(screen.queryByTestId("release-fix-auto")).toBeNull();
    // 公開できない理由は先頭の工程（#5076）が出すので、手動の公開操作の理由文は重ねない
    expect(screen.getByTestId("release-pull-request-journey")).toBeTruthy();
    expect(screen.queryByTestId("release-publish-blocked")).toBeNull();
  });

  it("要修正の候補は状態と操作を1か所へ寄せ、重複した表示を出さない（#5290）", async () => {
    verification = makeVerification(section("needs_check"));
    const needsFix = {
      ...(candidate("review", "needs_fix") as object),
      revisions: [{ revision: 3, status: "applied", reason: "initial", reasonLabel: "初回", importedPrs: [], baseSha: "a".repeat(40), headSha: "b".repeat(40), runUrl: null, failureReason: null, createdAt: "2026-10-12T00:00:00Z" }],
      finalizeContract: { candidateId: "c1", sequence: 12, revision: 3, prNumber: 768, baseSha: "a".repeat(40), headSha: "b".repeat(40), frozenDevelopSha: "a".repeat(40), includedPrs: [], requiresAiReviewWaiver: true },
    };
    rcOverview = {
      caller: { supported: true, reasonLabel: null } as never,
      candidate: needsFix as never,
      legacy: null,
      finalization: { caller: { supported: true, reasonLabel: null }, mainVersion: "1.0.0", checks: null, history: [], current: null, approval: null } as never,
    };
    render(<ReleasePullRequestOverview pullRequest={makePullRequest(true)} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-pull-request-journey")).toBeTruthy());
    // 結果を承知で進む開始と候補の取り消しは「その他の操作」にまとめ、公開準備の欄は出さない
    const more = screen.getByTestId("release-journey-more");
    expect(more.textContent).toContain("全体レビューの結果を承知で本番公開へ進む（公開承認）");
    expect(more.textContent).toContain("候補を取り消して作り直す");
    expect(screen.queryByTestId("release-rc-finalize")).toBeNull();
    expect(screen.queryByRole("region", { name: "候補の作り直し" })).toBeNull();
    // 重複していた表示
    expect(screen.queryByText("正式版は公開準備で確定します")).toBeNull();
    expect(screen.queryByTestId("release-journey-checks")).toBeNull();
    expect(screen.queryByTestId("release-fix-headline")).toBeNull();
    expect(screen.queryByTestId("release-guidance")).toBeNull();
    expect(screen.queryByText(/共通結果の対象/)).toBeNull();
    expect(screen.queryByText("公開結果（Webと配布は別）")).toBeNull();
    expect(screen.queryByTestId("release-rc-evidence")).toBeNull();
    expect(screen.queryByRole("region", { name: "候補の改訂履歴" })).toBeNull();
  });

  it("候補の状況を取得できていない間は公開操作を出さない", async () => {
    rcOverview = null;
    render(<ReleasePullRequestOverview pullRequest={makePullRequest(false)} onMerged={vi.fn()} />);
    // 候補の記録が無い間は、工程の承認以降を取得不能として出し、公開操作は出さない（#5076）
    await waitFor(() => expect(screen.getByTestId("release-pull-request-journey")).toBeTruthy());
    expect(screen.queryByText(/本番公開へ進む/)).toBeNull();
  });

  it("承認待ちでもドラフトのままなら出さない", async () => {
    rcOverview = { caller: { supported: true, reasonLabel: null } as never, candidate: candidate("awaiting_approval", "awaiting_approval"), legacy: null,
      finalization: finalization() };
    render(<ReleasePullRequestOverview pullRequest={makePullRequest(true)} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("release-pull-request-journey")).toBeTruthy());
    expect(screen.queryByText(/本番公開へ進む/)).toBeNull();
  });

  it("公開準備が済み、ドラフトでなく最終headと一致するときだけ出す", async () => {
    rcOverview = { caller: { supported: true, reasonLabel: null } as never, candidate: candidate("awaiting_approval", "awaiting_approval"), legacy: null,
      finalization: finalization() };
    render(<ReleasePullRequestOverview pullRequest={makePullRequest(false)} onMerged={vi.fn()} />);
    // 承認を経ない手動の公開は、主操作でなく「その他の操作」に置く（#5076・計画レビュー判断1-A）
    await waitFor(() => expect(screen.getByText("承認せずに本番公開へ進む")).toBeTruthy());
    expect(screen.getByText("承認せずに本番公開へ進む").closest("details")).toBeTruthy();
  });

  it("競合がGitHubの判定中でも公開操作は止めず、競合の詳細でマージ直前に待つことを案内する（#5178）", async () => {
    rcOverview = { caller: { supported: true, reasonLabel: null } as never, candidate: candidate("awaiting_approval", "awaiting_approval"), legacy: null,
      finalization: finalization() };
    render(<ReleasePullRequestOverview pullRequest={{ ...makePullRequest(false), mergeable: null }} onMerged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("承認せずに本番公開へ進む")).toBeTruthy());
    const conflict = screen.getByRole("button", { name: "コンフリクト: 確認中" });
    fireEvent.click(conflict);
    expect(screen.getByRole("group", { name: "コンフリクトの詳細" }).textContent).toContain(PENDING_CONFLICT_PUBLISH_NOTE);
  });

  it("競合の判定が出ていれば理由文は差し替えない", async () => {
    rcOverview = { caller: { supported: true, reasonLabel: null } as never, candidate: candidate("awaiting_approval", "awaiting_approval"), legacy: null,
      finalization: finalization() };
    render(<ReleasePullRequestOverview pullRequest={{ ...makePullRequest(false), mergeable: false }} onMerged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "コンフリクト: あり" }));
    expect(screen.getByRole("group", { name: "コンフリクトの詳細" }).textContent).not.toContain(PENDING_CONFLICT_PUBLISH_NOTE);
  });
});
