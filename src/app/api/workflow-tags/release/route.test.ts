import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const createNextWorkflowTag = vi.fn();
const dispatchPropagation = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/github/workflow-tags", () => ({
  get createNextWorkflowTag() {
    return createNextWorkflowTag;
  },
  get dispatchPropagation() {
    return dispatchPropagation;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/workflow-tags/release/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/workflow-tags/release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    createNextWorkflowTag.mockResolvedValue({ created: true, tag: "workflows/v23" });
    dispatchPropagation.mockResolvedValue({ dispatched: true });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("通常の環境ではタグを切って配布まで流す", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(200);
    expect(createNextWorkflowTag).toHaveBeenCalledWith("user-1");
    expect(dispatchPropagation).toHaveBeenCalledWith("user-1", true);
  });

  /**
   * #2441。このルートは配布の手前で`main`に本物のタグまで切るため、素通りすると
   * 開発サーバーの操作だけで本番のタグが増える。タグを切る前に止まることまで固定する。
   */
  it("プレビュー環境では403で封じる（タグを切る前に止める）", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(createNextWorkflowTag).not.toHaveBeenCalled();
    expect(dispatchPropagation).not.toHaveBeenCalled();
  });
});
