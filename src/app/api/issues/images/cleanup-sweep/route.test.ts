import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const runImageCleanupSweep = vi.fn();
vi.mock("@/lib/images/image-cleanup-run", () => ({
  get runImageCleanupSweep() {
    return runImageCleanupSweep;
  },
}));

vi.mock("@/lib/github/api-usage", () => ({
  withGithubApiFeature: (_feature: string, run: () => unknown) => run(),
}));

import { POST } from "@/app/api/issues/images/cleanup-sweep/route";

function request(body: unknown, authorization?: string): NextRequest {
  return {
    headers: new Headers(authorization === undefined ? {} : { Authorization: authorization }),
    json: async () => body,
  } as unknown as NextRequest;
}

describe("POST /api/issues/images/cleanup-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_SECRET = "test-secret";
    delete process.env.PREVIEW_MODE;
    runImageCleanupSweep.mockResolvedValue({ swept: true, trashed: { count: 0, size: 0 } });
  });

  it("シークレットが合わなければ巡回を呼ばない", async () => {
    const res = await POST(request({}, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(runImageCleanupSweep).not.toHaveBeenCalled();
  });

  it("確認環境では巡回を呼ばない（本番の画像を消させない）", async () => {
    process.env.PREVIEW_MODE = "true";
    const res = await POST(request({}, "Bearer test-secret"));
    expect(res.status).toBe(403);
    expect(runImageCleanupSweep).not.toHaveBeenCalled();
  });

  it("forceとfullをそのまま巡回へ渡す", async () => {
    const res = await POST(request({ force: true, full: true }, "Bearer test-secret"));
    expect(res.status).toBe(200);
    expect(runImageCleanupSweep).toHaveBeenCalledWith({ force: true, full: true });
  });

  it("巡回が落ちても500を返すだけで、pollerを止めない", async () => {
    runImageCleanupSweep.mockRejectedValue(new Error("boom"));
    const res = await POST(request({}, "Bearer test-secret"));
    expect(res.status).toBe(500);
  });
});
