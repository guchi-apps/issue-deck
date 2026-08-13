import { describe, expect, it, vi, beforeEach } from "vitest";

const requireUserId = vi.fn();
const repositoryFindMany = vi.fn();
const syncRepositoryIssues = vi.fn();
const addMissingProjectItems = vi.fn();
const syncProjectStatuses = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/sync-issues", () => ({
  get syncRepositoryIssues() {
    return syncRepositoryIssues;
  },
}));

vi.mock("@/lib/github/sync-project-status", () => ({
  get addMissingProjectItems() {
    return addMissingProjectItems;
  },
  get syncProjectStatuses() {
    return syncProjectStatuses;
  },
}));

import { POST } from "@/app/api/sync/issues/route";

const REPO = {
  id: "repo-1",
  fullName: "guchi-apps/car-care",
  installation: { installationId: 42 },
};

beforeEach(() => {
  requireUserId.mockReset().mockResolvedValue("user-1");
  repositoryFindMany.mockReset().mockResolvedValue([REPO]);
  syncRepositoryIssues.mockReset().mockResolvedValue(undefined);
  addMissingProjectItems.mockReset().mockResolvedValue({ added: 0, skipped: false });
  syncProjectStatuses.mockReset().mockResolvedValue({ updated: 0, cleared: 0, skipped: false });
});

describe("POST /api/sync/issues", () => {
  it("未ログインなら401", async () => {
    requireUserId.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(repositoryFindMany).not.toHaveBeenCalled();
  });

  // **順序が仕様（#1137）。** 逆順にすると、addMissingProjectItemsが追加直後に書いた
  // Statusを、syncProjectStatusesがProjectの読み直し結果（まだReadyを返さないことがある）で
  // 上書きしてしまう。DBがnullのままだと、載せた直後の最初のドラッグが無反応になる（#1132）。
  it("Projectの取り込みを先に行い、盤面への追加をそのあとに行う", async () => {
    const order: string[] = [];
    syncProjectStatuses.mockImplementation(async () => {
      order.push("sync");
      return { updated: 0, cleared: 0, skipped: false };
    });
    addMissingProjectItems.mockImplementation(async () => {
      order.push("backfill");
      return { added: 0, skipped: false };
    });

    await POST();

    expect(order).toEqual(["sync", "backfill"]);
  });

  it("Issueの取り込みはProject連携より先に行う", async () => {
    const order: string[] = [];
    syncRepositoryIssues.mockImplementation(async () => {
      order.push("issues");
    });
    syncProjectStatuses.mockImplementation(async () => {
      order.push("sync");
      return { updated: 0, cleared: 0, skipped: false };
    });

    await POST();

    // 盤面へ載せる際にDBのIssue行を更新するため、先に取り込んでおく必要がある
    expect(order).toEqual(["issues", "sync"]);
  });

  it("Project連携が無効（skipped）なら盤面への追加を行わない", async () => {
    syncProjectStatuses.mockResolvedValue({ updated: 0, cleared: 0, skipped: true });

    await POST();

    expect(addMissingProjectItems).not.toHaveBeenCalled();
  });

  it("Project連携が失敗しても200で返し、理由をerrorsに載せる", async () => {
    syncProjectStatuses.mockRejectedValue(new Error("boom"));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.errors).toEqual([{ repo: "projects-v2", message: "boom" }]);
    // `synced`は`repositories.length - errors.length`で数えており、リポジトリ単位の失敗と
    // Project連携の失敗を区別していない。そのためProject側が1件落ちると、実際には同期できた
    // リポジトリ数まで1つ減って見える（1 - 1 = 0）。現在の挙動としてここに固定しておく
    expect(body.synced).toBe(0);
  });
});
