import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { getRequestOrigin } from "@/lib/request-origin";
import { buildUploadedImageList, type UploadedImageFile } from "@/lib/uploaded-images";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "images");

/**
 * アップロード済み画像の一覧（#2462）。設定の「画像」区分がこれを読む。
 *
 * **配信（`GET /api/issues/images/[filename]`）と違い、ここはログイン必須にする。**
 * 配信が未認証なのはGitHub.com側のIssue画面から画像を表示するためで、UUIDを知らない人が
 * 画像へ辿り着けないことが前提になっている。一覧を未認証で出すとその前提が崩れる。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 1枚もアップロードしていない環境ではディレクトリ自体が無い（作るのはPOST）
  const filenames = await readdir(UPLOAD_DIR).catch(() => null);
  if (!filenames) {
    return NextResponse.json({ images: [] });
  }

  const files: UploadedImageFile[] = [];
  for (const filename of filenames) {
    const stats = await stat(path.join(UPLOAD_DIR, filename)).catch(() => null);
    if (!stats?.isFile()) continue;
    files.push({ filename, size: stats.size, modifiedAtMs: stats.mtimeMs });
  }

  return NextResponse.json({ images: buildUploadedImageList(files) });
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

  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, filename), buffer);

  const url = `${getRequestOrigin(request)}/api/issues/images/${filename}`;

  return NextResponse.json({ url, filename });
}
