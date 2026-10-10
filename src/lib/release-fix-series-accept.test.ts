import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seriesFindUnique: vi.fn(),
  seriesFindMany: vi.fn(),
  seriesUpdateMany: vi.fn(),
  repoFindFirst: vi.fn(),
  eventFindFirst: vi.fn(),
  fetchOpenPullRequestsForBase: vi.fn(),
  fetchReleaseRebuildCandidate: vi.fn(),
  recordRebuildEvent: vi.fn(async (_input: unknown) => "ev1"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    releaseFixSeries: { findUnique: mocks.seriesFindUnique, findMany: mocks.seriesFindMany, updateMany: mocks.seriesUpdateMany },
    repository: { findFirst: mocks.repoFindFirst },
    releaseRebuildEvent: { findFirst: mocks.eventFindFirst },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: vi.fn() }));
vi.mock("@/lib/github/issues-api", () => ({ addIssueLabels: vi.fn(), createComment: vi.fn(), createIssue: vi.fn(), updateIssue: vi.fn() }));
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: mocks.fetchOpenPullRequestsForBase,
  fetchPullRequestsByHead: vi.fn(),
  fetchReleaseRebuildCandidate: mocks.fetchReleaseRebuildCandidate,
  releaseCallerSupportsSelection: vi.fn(),
}));
vi.mock("@/lib/github/release-workflow-cache", () => ({ releaseWorkflowExists: vi.fn() }));
vi.mock("@/lib/release-rebuild-run", () => ({ rebuildReleaseCandidate: vi.fn() }));
vi.mock("@/lib/release-rebuild-selection-run", () => ({ requestSelectiveRebuild: vi.fn() }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: vi.fn() }));
vi.mock("@/lib/release-rebuild-history-run", () => ({
  recordRebuildEvent: mocks.recordRebuildEvent,
  findLatestApprovalEventId: vi.fn(),
}));

import { acceptReleaseFixExtraPullRequests } from "@/lib/release-fix-series-run";

const HEAD = "d".repeat(40);
const row = { id: "s1", status: "awaiting_decision", repositoryFullName: "o/r", releasePrNumber: 4345, originHeadSha: HEAD, fixPrNumber: 4353 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seriesFindUnique.mockResolvedValue(row);
  mocks.seriesFindMany.mockResolvedValue([row]);
  mocks.repoFindFirst.mockResolvedValue({ installation: { installationId: 1 } });
  mocks.fetchOpenPullRequestsForBase.mockResolvedValue([{ number: 4345, head: { ref: "release-main/v8.51.0", sha: HEAD } }]);
  mocks.seriesUpdateMany.mockResolvedValue({ count: 1 });
});

describe("acceptReleaseFixExtraPullRequests", () => {
  it("判断待ちにした時点のPRと修正PRだけを承認し、承認までに入ったPRは承認済みにしない。操作者を残す", async () => {
    mocks.eventFindFirst.mockResolvedValue({ payload: { pendingPrs: [4339, 4344] } });
    mocks.fetchReleaseRebuildCandidate.mockResolvedValue({
      pullRequests: [4339, 4344, 4353, 4360].map((number) => ({ number, title: `PR${number}`, mergeSha: "a".repeat(40) })),
    });

    expect(await acceptReleaseFixExtraPullRequests("s1", "user1")).toEqual({ ok: true });

    const event = mocks.recordRebuildEvent.mock.calls[0][0] as { kind: string; actor: unknown; trigger: string; payload: { approvedPrs: { number: number }[] } };
    expect(event).toMatchObject({ kind: "approval", actor: { kind: "user", userId: "user1" }, trigger: "manual" });
    expect(event.payload.approvedPrs.map((p) => p.number)).toEqual([4339, 4344, 4353]);
    expect(mocks.seriesUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ acceptedExtraPrs: [4339, 4344, 4353] }) }),
    );
  });

  it("判断待ちの範囲の記録が無い既存の待ちは、承認時点の候補全体を範囲にして、その旨を理由に残す", async () => {
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.fetchReleaseRebuildCandidate.mockResolvedValue({ pullRequests: [{ number: 1, title: "a", mergeSha: null }] });
    await acceptReleaseFixExtraPullRequests("s1", "user1");
    expect((mocks.recordRebuildEvent.mock.calls[0][0] as { reason: string }).reason).toContain("記録が無い");
  });

  it("同時の承認・巡回で状態が先に動いていたら、書き換えず承認済みにしない", async () => {
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.fetchReleaseRebuildCandidate.mockResolvedValue({ pullRequests: [] });
    mocks.seriesUpdateMany.mockResolvedValue({ count: 0 });
    expect(await acceptReleaseFixExtraPullRequests("s1", "user1")).toEqual({ ok: false, error: "not_awaiting_decision" });
  });
});
