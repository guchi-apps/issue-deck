import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, deleteMany, aggregate, repositoryFindFirst, cutoffFindUnique, cutoffUpsert } = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  aggregate: vi.fn(),
  repositoryFindFirst: vi.fn(),
  cutoffFindUnique: vi.fn(),
  cutoffUpsert: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    releaseRebuildEvent: { findMany, deleteMany, aggregate },
    repository: { findFirst: repositoryFindFirst },
    releaseRebuildHistoryCutoff: { findUnique: cutoffFindUnique, upsert: cutoffUpsert },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: vi.fn(),
  fetchPullMergeInfo: vi.fn(),
  fetchTagRefs: vi.fn(),
}));
vi.mock("@/lib/github/pull-requests-api", () => ({ CLOSED_PAGED_PER_PAGE: 100, fetchClosedPullRequestsForBasePage: vi.fn() }));

import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";
import { fetchClosedPullRequestsForBasePage } from "@/lib/github/pull-requests-api";
import { collectMergedReleasePrs, purgeCompletedRebuildEvents, sweepCompletedRebuildHistory } from "./release-rebuild-history-run";

function closedPr(number: number, ref: string, merged: boolean): GithubApiOpenPullRequest {
  return { number, merged_at: merged ? "2026-10-01T00:00:00Z" : null, head: { ref, sha: `s${number}` } } as GithubApiOpenPullRequest;
}

/** 番号の降順に並んだclosed PRを100件ずつ返す */
function pager(prs: GithubApiOpenPullRequest[]) {
  return vi.fn(async (page: number) => prs.slice((page - 1) * 100, page * 100));
}

describe("collectMergedReleasePrs（#4474）", () => {
  it("閉じた作り直し候補が1ページを埋めても、次のページの完了リリースまで遡る", async () => {
    const prs = [
      ...Array.from({ length: 120 }, (_, i) => closedPr(500 - i, `release-main/v8.${i}`, false)),
      closedPr(300, "release-main/v8.0.0", true),
      closedPr(299, "release-main/v7.9.0", true),
    ];
    const fetchPage = pager(prs);
    const found = await collectMergedReleasePrs(fetchPage, { floor: 0, enough: 1 });
    expect(found.map((pr) => pr.number)).toEqual([300]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("floor以下の番号に達したら打ち切り、それより古いリリースは見ない", async () => {
    const prs = [closedPr(50, "issue-1", true), closedPr(40, "release-main/v1.0.0", true)];
    const found = await collectMergedReleasePrs(pager(prs), { floor: 45, enough: 1 });
    expect(found).toEqual([]);
  });

  it("リリース以外のマージ済みPRや閉じただけの候補は数えず、enough件まで集める", async () => {
    const prs = [
      closedPr(9, "deploy-recovery/x", true),
      closedPr(8, "release-main/v1.2.0", true),
      closedPr(7, "release-main/v1.1.9", false),
      closedPr(6, "release-main/v1.1.0", true),
      closedPr(5, "release-main/v1.0.0", true),
    ];
    const found = await collectMergedReleasePrs(pager(prs), { floor: 0, enough: 2 });
    expect(found.map((pr) => pr.number)).toEqual([8, 6]);
  });

  it("ページ数の上限で止まる", async () => {
    const fetchPage = vi.fn(async (page: number) => Array.from({ length: 100 }, (_, i) => closedPr(100000 - page * 100 - i, "issue-1", true)));
    const found = await collectMergedReleasePrs(fetchPage, { floor: 0, enough: 1, maxPages: 3 });
    expect(found).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});

describe("purgeCompletedRebuildEvents（#4420）", () => {
  beforeEach(() => {
    findMany.mockReset();
    deleteMany.mockReset().mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
  });

  it("境界以下の経過を削除し、後継が境界を超える作成中の経過は残す", async () => {
    findMany.mockResolvedValue([
      { id: "a1", originPrNumber: 10, originHeadSha: "h10", kind: "rebuild_started", payload: {} },
      { id: "a2", originPrNumber: 10, originHeadSha: "h10", kind: "successor_created", payload: { successor: { number: 11 } } },
      { id: "b1", originPrNumber: 12, originHeadSha: "h12", kind: "rebuild_started", payload: {} },
      { id: "b2", originPrNumber: 12, originHeadSha: "h12", kind: "successor_created", payload: { successor: { number: 15 } } },
    ]);
    const count = await purgeCompletedRebuildEvents("guchi-apps/x", 12);
    expect(count).toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] } } });
    expect(findMany.mock.calls[0][0].where).toEqual({ repositoryFullName: "guchi-apps/x", originPrNumber: { lte: 12 } });
  });
});

describe("sweepCompletedRebuildHistory（#4488）", () => {
  it("残る履歴の最小の元候補がマージ済みリリースPRそのものでも、境界として判定する", async () => {
    repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
    cutoffFindUnique.mockResolvedValue(null);
    aggregate.mockResolvedValue({ _min: { originPrNumber: 100 } });
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 0 });
    vi.mocked(fetchClosedPullRequestsForBasePage).mockResolvedValue([closedPr(100, "release-main/v1.0.0", true)]);
    const result = await sweepCompletedRebuildHistory("o/r");
    expect(result.completedThrough).toBe(100);
    expect(cutoffUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: { repositoryFullName: "o/r", completedThroughPrNumber: 100 } }));
  });
});
