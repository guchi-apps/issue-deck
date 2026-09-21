import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const requireUserId = vi.fn();
vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

const getAppAiToken = vi.fn();
vi.mock("@/lib/claude/request", () => ({
  get getAppAiToken() {
    return getAppAiToken;
  },
}));

const generateImageExtract = vi.fn();
vi.mock("@/lib/claude/image-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/claude/image-extract")>();
  return {
    ...actual,
    get generateImageExtract() {
      return generateImageExtract;
    },
  };
});

import { POST } from "@/app/api/issues/image-extract/route";
import { ImageExtractError } from "@/lib/claude/image-extract";

function requestWith(payload: unknown) {
  return { json: async () => payload } as unknown as NextRequest;
}

describe("POST /api/issues/image-extract", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    getAppAiToken.mockReset().mockResolvedValue("token");
    generateImageExtract.mockReset();
  });

  it("未ログインは401", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(requestWith({ images: [] }))).status).toBe(401);
  });

  it("認証情報が無ければ501", async () => {
    getAppAiToken.mockResolvedValue(null);
    expect((await POST(requestWith({ images: ["a"] }))).status).toBe(501);
  });

  it("imagesが文字列の配列でなければ400", async () => {
    expect((await POST(requestWith({ images: [1] }))).status).toBe(400);
    expect((await POST(requestWith({}))).status).toBe(400);
  });

  it("成功したら結果をそのまま返す", async () => {
    generateImageExtract.mockResolvedValue({ items: ["A"], unreadable: false });
    const res = await POST(requestWith({ images: ["u"] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ["A"], unreadable: false });
    expect(generateImageExtract).toHaveBeenCalledWith("token", ["u"]);
  });

  it("利用者向けのエラーはコードに応じたステータスと文言で返す", async () => {
    generateImageExtract.mockRejectedValue(new ImageExtractError("image_too_large", "大きすぎます"));
    const res = await POST(requestWith({ images: ["u"] }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "image_too_large", message: "大きすぎます" });
  });

  it("想定外の失敗は502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    generateImageExtract.mockRejectedValue(new Error("boom"));
    expect((await POST(requestWith({ images: ["u"] }))).status).toBe(502);
  });
});
