import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const getCurrentUser = vi.fn();
vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

// 一覧（GET）が使う在庫の組み立てはGitHub Appの設定まで読み込むため、POSTの検証では差し替える
vi.mock("@/lib/images/image-cleanup-run", () => ({ getUploadedImageInventory: vi.fn() }));

import { POST } from "@/app/api/issues/images/route";
import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";

function uploadRequest(file: File, authorization?: string) {
  const formData = new FormData();
  formData.append("file", file);
  return {
    headers: new Headers({ host: "issue-deck.test", ...(authorization ? { authorization } : {}) }),
    formData: () => Promise.resolve(formData),
  } as unknown as NextRequest;
}

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

describe("POST /api/issues/images", () => {
  const saved: string[] = [];

  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "user-1" });
  });

  afterEach(async () => {
    for (const filename of saved.splice(0)) {
      await rm(path.join(UPLOADED_IMAGE_DIR, filename), { force: true });
    }
  });

  it("未ログインなら401", async () => {
    getCurrentUser.mockResolvedValue(null);

    const res = await POST(uploadRequest(new File([SVG], "a.svg", { type: "image/svg+xml" })));

    expect(res.status).toBe(401);
  });

  describe("Bearer認証（#3507）", () => {
    const file = () => new File([SVG], "a.svg", { type: "image/svg+xml" });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("IMAGE_UPLOAD_SECRETが一致すればCookie無しで保存できる", async () => {
      vi.stubEnv("IMAGE_UPLOAD_SECRET", "s3cret");
      getCurrentUser.mockResolvedValue(null);

      const res = await POST(uploadRequest(file(), "Bearer s3cret"));
      const body = (await res.json()) as { url: string; filename: string };
      saved.push(body.filename);

      expect(res.status).toBe(200);
      expect(body.url).toBe(`http://issue-deck.test/api/issues/images/${body.filename}`);
    });

    it("値が違えば、ログイン中でも401（Cookieへフォールバックしない）", async () => {
      vi.stubEnv("IMAGE_UPLOAD_SECRET", "s3cret");

      const res = await POST(uploadRequest(file(), "Bearer wrong"));

      expect(res.status).toBe(401);
    });

    it("未設定なら503 not_configured", async () => {
      vi.stubEnv("IMAGE_UPLOAD_SECRET", "");

      const res = await POST(uploadRequest(file(), "Bearer anything"));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    });

    it("PROGRESS_REPORT_SECRET・DISPATCH_SECRETでは通らない", async () => {
      vi.stubEnv("IMAGE_UPLOAD_SECRET", "upload");
      vi.stubEnv("PROGRESS_REPORT_SECRET", "progress");
      vi.stubEnv("DISPATCH_SECRET", "dispatch");

      expect((await POST(uploadRequest(file(), "Bearer progress"))).status).toBe(401);
      expect((await POST(uploadRequest(file(), "Bearer dispatch"))).status).toBe(401);
    });

    it("Bearerでも形式検査は従来どおり（415）", async () => {
      vi.stubEnv("IMAGE_UPLOAD_SECRET", "s3cret");

      const res = await POST(
        uploadRequest(new File(["x"], "a.txt", { type: "text/plain" }), "Bearer s3cret"),
      );

      expect(res.status).toBe(415);
    });
  });

  it("SVGを.svgのUUID名で保存し、配信URLを返す（#3286）", async () => {
    const res = await POST(uploadRequest(new File([SVG], "icon.svg", { type: "image/svg+xml" })));
    const body = (await res.json()) as { url: string; filename: string };
    saved.push(body.filename);

    expect(res.status).toBe(200);
    expect(body.filename).toMatch(/^[0-9a-f-]{36}\.svg$/);
    expect(body.url).toBe(`http://issue-deck.test/api/issues/images/${body.filename}`);
    expect(await readFile(path.join(UPLOADED_IMAGE_DIR, body.filename), "utf8")).toBe(SVG);
  });

  it("SVGを名乗るがSVG文書でないファイル（HTMLなど）は保存せず415にする（#3286）", async () => {
    const html = "<html><body><script>alert(1)</script></body></html>";

    const res = await POST(uploadRequest(new File([html], "evil.svg", { type: "image/svg+xml" })));

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "invalid_svg" });
  });

  it("対象外のMIMEタイプは従来どおり415", async () => {
    const res = await POST(uploadRequest(new File(["x"], "a.txt", { type: "text/plain" })));

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media_type" });
  });

  it("PNGは従来どおり保存できる", async () => {
    const res = await POST(uploadRequest(new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" })));
    const body = (await res.json()) as { filename: string };
    saved.push(body.filename);

    expect(res.status).toBe(200);
    expect(body.filename).toMatch(/\.png$/);
  });
});
