import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, deleteMany } = vi.hoisted(() => ({ findMany: vi.fn(), deleteMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { releaseRebuildEvent: { findMany, deleteMany } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: vi.fn(),
  fetchPullMergeInfo: vi.fn(),
  fetchTagRefs: vi.fn(),
}));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchClosedPullRequestsForBase: vi.fn() }));

import { purgeCompletedRebuildEvents } from "./release-rebuild-history-run";

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
