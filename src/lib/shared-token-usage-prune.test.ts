import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { sharedTokenUsage: { deleteMany } } }));

import { pruneOldSharedTokenUsages, SHARED_TOKEN_USAGE_RETENTION_DAYS } from "./shared-token-usage-prune";

describe("pruneOldSharedTokenUsages", () => {
  beforeEach(() => deleteMany.mockReset());

  it("保持日数より古い利用記録だけを消し、件数を返す", async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-10-08T00:00:00Z");
    expect(await pruneOldSharedTokenUsages(now)).toBe(3);
    const before = deleteMany.mock.calls[0][0].where.usedAt.lt as Date;
    expect(now.getTime() - before.getTime()).toBe(SHARED_TOKEN_USAGE_RETENTION_DAYS * 86_400_000);
  });
});
