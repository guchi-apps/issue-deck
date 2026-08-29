import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

import { GET } from "@/app/api/issues/images/[filename]/route";
import { UPLOADED_IMAGE_DIR, UPLOADED_IMAGE_TRASH_DIR } from "@/lib/images/image-storage";

const FILENAME = "dddddddd-1111-2222-3333-444444444444.png";
const BYTES = Buffer.from([137, 80, 78, 71]);

function params(filename: string) {
  return { params: Promise.resolve({ filename }) };
}

const request = {} as NextRequest;

describe("GET /api/issues/images/[filename]", () => {
  beforeEach(async () => {
    await mkdir(UPLOADED_IMAGE_TRASH_DIR, { recursive: true });
  });

  afterEach(async () => {
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

  it("どちらにも無ければ404", async () => {
    expect((await GET(request, params(FILENAME))).status).toBe(404);
  });
});
