import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const dispatchRepairPropagation = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/github/workflow-tags", () => ({
  get dispatchRepairPropagation() {
    return dispatchRepairPropagation;
  },
}));

import { POST } from "@/app/api/workflow-tags/propagate-repair/route";

describe("POST /api/workflow-tags/propagate-repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    dispatchRepairPropagation.mockResolvedValue({ dispatched: true });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("通常の環境ではcaller追加のPR作成を起動する", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(dispatchRepairPropagation).toHaveBeenCalledWith("user-1");
  });

  /** #2441。開発サーバーから本番の配布ワークフローを起動しない。 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST();

    expect(response.status).toBe(403);
    expect(dispatchRepairPropagation).not.toHaveBeenCalled();
  });
});
