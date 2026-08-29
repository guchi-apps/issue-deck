import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { getUploadedImageInventory } from "@/lib/images/image-cleanup-run";
import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";
import { getRequestOrigin } from "@/lib/request-origin";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * アップロード済み画像の一覧・容量・使用状況（#2462・#2475）。設定の「画像」区分がこれを読む。
 *
 * **配信（`GET /api/issues/images/[filename]`）と違い、ここはログイン必須にする。**
 * 配信が未認証なのはGitHub.com側のIssue画面から画像を表示するためで、UUIDを知らない人が
 * 画像へ辿り着けないことが前提になっている。一覧を未認証で出すとその前提が崩れる。
 *
 * 中身の組み立ては`getUploadedImageInventory`（ファイルの読み取り・参照の索引・設定を
 * まとめる）。GitHubへは問い合わせない——参照を集めるのは巡回の役目で、画面はその結果を読む。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const inventory = await getUploadedImageInventory();
  return NextResponse.json(inventory, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const extension = EXTENSION_BY_CONTENT_TYPE[file.type];
  if (!extension) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const filename = `${randomUUID()}.${extension}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
  await writeFile(path.join(UPLOADED_IMAGE_DIR, filename), buffer);

  const url = `${getRequestOrigin(request)}/api/issues/images/${filename}`;

  return NextResponse.json({ url, filename });
}
