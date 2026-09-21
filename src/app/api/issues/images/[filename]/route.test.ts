import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const getCurrentUser = vi.fn();
vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

import { GET } from "@/app/api/issues/images/[filename]/route";
import { UPLOADED_IMAGE_DIR, UPLOADED_IMAGE_TRASH_DIR } from "@/lib/images/image-storage";

const FILENAME = "dddddddd-1111-2222-3333-444444444444.png";
const BYTES = Buffer.from([137, 80, 78, 71]);

function params(filename: string) {
  return { params: Promise.resolve({ filename }) };
}

function requestWith(authorization?: string) {
  return { headers: new Headers(authorization ? { authorization } : {}) } as NextRequest;
}

const request = requestWith();

describe("GET /api/issues/images/[filename]", () => {
  beforeEach(async () => {
    await mkdir(UPLOADED_IMAGE_TRASH_DIR, { recursive: true });
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    vi.stubEnv("PROGRESS_REPORT_SECRET", "progress-secret");
    vi.stubEnv("DISPATCH_SECRET", "dispatch-secret");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(path.join(UPLOADED_IMAGE_DIR, FILENAME), { force: true });
    await rm(path.join(UPLOADED_IMAGE_TRASH_DIR, FILENAME), { force: true });
  });

  it("UUID形式でないファイル名は読まずに404にする（パストラバーサルの防波堤）", async () => {
    expect((await GET(request, params("../../etc/passwd"))).status).toBe(404);
    // ゴミ箱のディレクトリ名そのものも通さない
    expect((await GET(request, params(".trash"))).status).toBe(404);
  });

  it("ゴミ箱へ移した後も、完全に削除されるまでは配信し続ける（#2475）", async () => {
    await writeFile(path.join(UPLOADED_IMAGE_TRASH_DIR, FILENAME), BYTES);

    const res = await GET(request, params(FILENAME));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("SVGは画像として配信しつつ、直接開かれても実行されないヘッダーを付ける（#3286）", async () => {
    const svgName = FILENAME.replace(/\.png$/, ".svg");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
    await writeFile(path.join(UPLOADED_IMAGE_DIR, svgName), svg);
    try {
      const res = await GET(request, params(svgName));

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    } finally {
      await rm(path.join(UPLOADED_IMAGE_DIR, svgName), { force: true });
    }
  });

  it("SVG以外にはCSPを付けない（従来どおり）", async () => {
    await writeFile(path.join(UPLOADED_IMAGE_TRASH_DIR, FILENAME), BYTES);

    const res = await GET(request, params(FILENAME));

    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("どちらにも無ければ404", async () => {
    expect((await GET(request, params(FILENAME))).status).toBe(404);
  });

  describe("読める相手を限定する（#2967）", () => {
    beforeEach(async () => {
      await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
      await writeFile(path.join(UPLOADED_IMAGE_DIR, FILENAME), BYTES);
    });

    it("ログインしていなければ401（GitHub.com経由の匿名の取得を含む）", async () => {
      getCurrentUser.mockResolvedValue(null);

      const res = await GET(request, params(FILENAME));

      expect(res.status).toBe(401);
    });

    it("未認証なら、ファイルが無くても404ではなく401にする（UUIDの存在を明かさない）", async () => {
      getCurrentUser.mockResolvedValue(null);
      await rm(path.join(UPLOADED_IMAGE_DIR, FILENAME), { force: true });

      expect((await GET(request, params(FILENAME))).status).toBe(401);
    });

    it("ログイン中の本人には共有キャッシュへ載らない形で返す", async () => {
      const res = await GET(request, params(FILENAME));

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    });

    it.each([
      ["PROGRESS_REPORT_SECRET（無人実行）", "Bearer progress-secret"],
      ["DISPATCH_SECRET（ローカルセッション）", "Bearer dispatch-secret"],
    ])("%sを持つAIはログインなしで読める", async (_label, authorization) => {
      getCurrentUser.mockResolvedValue(null);

      const res = await GET(requestWith(authorization), params(FILENAME));

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    });

    it("シークレットが違えば、ログイン中でも401（誤ったヘッダーを黙って見逃さない）", async () => {
      const res = await GET(requestWith("Bearer wrong"), params(FILENAME));

      expect(res.status).toBe(401);
    });

    it("シークレットが未設定の環境では、空のBearerで通らない", async () => {
      getCurrentUser.mockResolvedValue(null);
      vi.stubEnv("PROGRESS_REPORT_SECRET", "");
      vi.stubEnv("DISPATCH_SECRET", "");

      expect((await GET(requestWith("Bearer "), params(FILENAME))).status).toBe(401);
    });
  });
});
