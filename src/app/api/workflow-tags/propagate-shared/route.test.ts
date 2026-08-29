import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const dispatchSharedFilePropagation = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/github/workflow-tags", () => ({
  get dispatchSharedFilePropagation() {
    return dispatchSharedFilePropagation;
  },
}));

import { POST } from "@/app/api/workflow-tags/propagate-shared/route";

describe("POST /api/workflow-tags/propagate-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    dispatchSharedFilePropagation.mockResolvedValue({ dispatched: true });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("通常の環境では配布物の更新PR作成を起動する", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(dispatchSharedFilePropagation).toHaveBeenCalledWith("user-1");
  });

  /** #2441。開発サーバーから本番の配布ワークフローを起動しない。 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST();

    expect(response.status).toBe(403);
    expect(dispatchSharedFilePropagation).not.toHaveBeenCalled();
  });
});
