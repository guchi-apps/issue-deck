import { describe, expect, it } from "vitest";

import { buildSharedTokenReviewMeta } from "./release-review-shared-token-meta";

describe("buildSharedTokenReviewMeta", () => {
  it("値や参照を含めず、更新日時・最終利用・利用元だけを返す", () => {
    const rows = [
      { id: "1", name: "A_KEY", updatedAt: new Date("2026-10-01T00:00:00Z"), encryptedValue: "SECRET", sourceReference: "op://x" },
      { id: "2", name: "B_KEY", updatedAt: new Date("2026-10-02T00:00:00Z") },
    ];
    const usages = [
      { sharedTokenId: "1", consumer: "kurashio", usedAt: new Date("2026-10-03T00:00:00Z") },
      { sharedTokenId: "1", consumer: "aide", usedAt: new Date("2026-10-05T00:00:00Z") },
    ];
    const result = buildSharedTokenReviewMeta(rows, usages);
    expect(result[0]).toEqual({ name: "A_KEY", updatedAt: "2026-10-01T00:00:00.000Z", lastUsedAt: "2026-10-05T00:00:00.000Z", consumers: ["aide", "kurashio"] });
    expect(result[1].lastUsedAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/SECRET|op:\/\//);
  });
});
