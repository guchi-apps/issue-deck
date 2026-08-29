import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { isUploadedImageFilename } from "@/lib/uploaded-images";

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "images");

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // アップロードAPI（route.ts）が発行するUUIDファイル名の形式のみ許可し、パストラバーサルを防ぐ。
  if (!isUploadedImageFilename(filename)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const extension = filename.slice(filename.lastIndexOf(".") + 1);

  try {
    const buffer = await readFile(path.join(UPLOAD_DIR, filename));
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": CONTENT_TYPE_BY_EXTENSION[extension],
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}

/**
 * 画像1枚を削除する（#2462）。設定の「画像」区分の×ボタンから呼ぶ。
 *
 * **配信のGETと違いログイン必須。** 消えるのはVPS上の実ファイルだけで、その画像を貼った
 * Issue本文・コメントのMarkdownはGitHub側に残る（そこは画像が表示されなくなる）。
 * 取り消せないので、確認は画面側（`ImagesSection`）で取る。
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  if (!isUploadedImageFilename(filename)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    await unlink(path.join(UPLOAD_DIR, filename));
  } catch (error) {
    // すでに消えている場合は、一覧を取り直せば消えるので成功と区別しない
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
