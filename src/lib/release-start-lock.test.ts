import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { releaseStartLock: mocks } }));

import { acquireReleaseStartLock, RELEASE_START_LOCK_TTL_MS, releaseReleaseStartLock } from "@/lib/release-start-lock";

const NOW = new Date("2026-10-17T00:00:00Z");

describe("release-start-lock", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({});
    mocks.updateMany.mockReset().mockResolvedValue({ count: 0 });
    mocks.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("行が無ければ作って確保する（期限は一定時間後）", async () => {
    expect(await acquireReleaseStartLock("o/r", NOW)).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith({
      data: { repositoryFullName: "o/r", acquiredAt: NOW, expiresAt: new Date(NOW.getTime() + RELEASE_START_LOCK_TTL_MS) },
    });
  });

  it("他の要求が期限内に保持していれば確保できない", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" });
    expect(await acquireReleaseStartLock("o/r", NOW)).toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { repositoryFullName: "o/r", expiresAt: { lte: NOW } } }));
  });

  it("期限切れの行は条件付き更新で1件だけが取り直せる", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    expect(await acquireReleaseStartLock("o/r", NOW)).toBe(true);
  });

  it("一意制約以外のエラーは握りつぶさない", async () => {
    mocks.create.mockRejectedValue(new Error("db down"));
    await expect(acquireReleaseStartLock("o/r", NOW)).rejects.toThrow("db down");
  });

  it("手放しの失敗は開始処理を壊さない", async () => {
    mocks.deleteMany.mockRejectedValue(new Error("x"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(releaseReleaseStartLock("o/r")).resolves.toBeUndefined();
  });
});
