import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const dispatchPropagation = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/github/workflow-tags", () => ({
  get dispatchPropagation() {
    return dispatchPropagation;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/workflow-tags/propagate/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/workflow-tags/propagate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    dispatchPropagation.mockResolvedValue({ dispatched: true });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("通常の環境では配布を起動する", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(200);
    expect(dispatchPropagation).toHaveBeenCalledWith("user-1", true);
  });

  /**
   * #2441。worktreeの`.env.local`には`PREVIEW_MODE=true`が入っているため、ここが素通りすると
   * 開発サーバーの「配布」ボタンから本番の配布ワークフローが起動し、14リポジトリへPRが出る。
   */
  it("プレビュー環境では403で封じる（開発サーバーから本番の配布を起動しない）", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(dispatchPropagation).not.toHaveBeenCalled();
  });
});
