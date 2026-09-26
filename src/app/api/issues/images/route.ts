import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { authorizeImageUpload } from "@/lib/images/image-upload-auth";
import { getUploadedImageInventory } from "@/lib/images/image-cleanup-run";
import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";
import { getRequestOrigin } from "@/lib/request-origin";
import { looksLikeSvg, SVG_HEAD_SCAN_BYTES } from "@/lib/uploaded-images";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * アップロード済み画像の一覧・容量・使用状況（#2462・#2475）。設定の「画像」区分がこれを読む。
 *
 * **ログイン必須。** 配信（`GET /api/issues/images/[filename]`）は共有シークレットでも
 * 読めるが（AI向け。#2967）、一覧はファイル名をまとめて明かすため画面の利用者だけに出す。
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

/**
 * アップロードしてよい呼び出し元か（#3507）。
 *
 * Authorizationヘッダが付いていれば`Bearer IMAGE_UPLOAD_SECRET`（AIDEなどサーバー間）だけを見て、
 * 付いていなければ従来どおりログインCookieを見る。ヘッダ付きで外れたときにCookieへ
 * フォールバックしない（誤った鍵を黙って通さない）。
 */
async function authorizeUpload(request: NextRequest): Promise<NextResponse | null> {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const auth = authorizeImageUpload(authorization);
    if (auth === "ok") return null;
    if (auth === "not_configured") {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const denied = await authorizeUpload(request);
  if (denied) return denied;

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

  const buffer = Buffer.from(await file.arrayBuffer());

  // SVGは拡張子・MIMEを名乗るだけのHTMLなどを保存しないよう、先頭がSVG文書かを確かめる（#3286）
  if (extension === "svg" && !looksLikeSvg(buffer.subarray(0, SVG_HEAD_SCAN_BYTES).toString("utf8"))) {
    return NextResponse.json({ error: "invalid_svg" }, { status: 415 });
  }

  const filename = `${randomUUID()}.${extension}`;

  await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
  await writeFile(path.join(UPLOADED_IMAGE_DIR, filename), buffer);

  const url = `${getRequestOrigin(request)}/api/issues/images/${filename}`;

  return NextResponse.json({ url, filename });
}
