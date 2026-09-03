import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const updateMany = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    nightlyRunEntry: {
      get updateMany() {
        return updateMany;
      },
    },
  },
}));

import type { NextRequest } from "next/server";

import { DELETE } from "@/app/api/nightly-run/[id]/route";

const REQUEST = {} as NextRequest;
const CONTEXT = { params: Promise.resolve({ id: "entry-1" }) };

describe("DELETE /api/nightly-run/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("未処理の予定だけを取り消し、二重投入の鍵を空ける", async () => {
    const response = await DELETE(REQUEST, CONTEXT);

    expect(response.status).toBe(200);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "entry-1", status: "QUEUED" },
      data: { status: "CANCELED", activeKey: null },
    });
  });

  it("すでに起動した・取り消した予定は404", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    const response = await DELETE(REQUEST, CONTEXT);

    expect(response.status).toBe(404);
  });

  /** #2441 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await DELETE(REQUEST, CONTEXT);

    expect(response.status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
