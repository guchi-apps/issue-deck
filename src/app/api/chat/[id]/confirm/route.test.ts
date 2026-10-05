import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
const executeConfirmedCard = vi.fn();
const findFirst = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const create = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));
vi.mock("@/lib/chat/handlers", () => ({
  get executeConfirmedCard() {
    return executeConfirmedCard;
  },
  withAction: (context: unknown) => context,
}));
vi.mock("@/lib/db", () => ({
  db: {
    chatMessage: {
      get findFirst() {
        return findFirst;
      },
      get updateMany() {
        return updateMany;
      },
      get update() {
        return update;
      },
      get create() {
        return create;
      },
    },
    chatConversation: { update: vi.fn() },
    get $transaction() {
      return transaction;
    },
  },
}));

import { POST } from "@/app/api/chat/[id]/confirm/route";

const params = { params: Promise.resolve({ id: "c1" }) };
const request = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;
const repairCard = { type: "confirm_repair", repo: "a/b", number: 1, title: "t", kinds: ["ci"] };
const message = {
  id: "m1",
  confirmState: "pending",
  cards: [repairCard],
  conversation: { context: {} },
};
const reply = { id: "r1", role: "assistant", text: "x", cards: [], confirmState: null, createdAt: new Date() };

describe("POST /api/chat/[id]/confirm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.PREVIEW_MODE;
    getCurrentUser.mockResolvedValue({ id: "u1" });
    findFirst.mockResolvedValue(message);
    transaction.mockResolvedValue([reply]);
    create.mockResolvedValue(reply);
  });

  it("未ログインは401で何も実行しない", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(request({ messageId: "m1", action: "execute" }), params);
    expect(res.status).toBe(401);
    expect(executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("pendingを取れたときだけ実行する", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    executeConfirmedCard.mockResolvedValue({
      ok: true,
      text: "起動",
      card: { type: "result", ok: true, title: "t", detail: null, htmlUrl: null },
      action: { type: "repair", status: "started", repo: "a/b", number: 1, at: "", message: "" },
    });
    const res = await POST(request({ messageId: "m1", action: "execute" }), params);
    expect(res.status).toBe(200);
    expect(executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(executeConfirmedCard.mock.calls[0][1]).toEqual(repairCard);
  });

  it("すでに押された確認カードは409で再実行しない（二重実行の防止）", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(request({ messageId: "m1", action: "execute" }), params);
    expect(res.status).toBe(409);
    expect(executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("やめるは何も実行しない", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(request({ messageId: "m1", action: "cancel" }), params);
    expect(res.status).toBe(200);
    expect(executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("失敗したときは押し直せるようpendingへ戻す", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    executeConfirmedCard.mockResolvedValue({
      ok: false,
      text: "失敗",
      card: { type: "result", ok: false, title: "t", detail: "d", htmlUrl: null },
      action: { type: "repair", status: "failed", repo: "a/b", number: 1, at: "", message: "" },
    });
    await POST(request({ messageId: "m1", action: "execute" }), params);
    expect(update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { confirmState: "pending" } });
  });

  it("プレビュー環境では実行を403で止める", async () => {
    process.env.PREVIEW_MODE = "true";
    const res = await POST(request({ messageId: "m1", action: "execute" }), params);
    expect(res.status).toBe(403);
    expect(executeConfirmedCard).not.toHaveBeenCalled();
  });
});
