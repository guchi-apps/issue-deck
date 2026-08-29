import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { UPLOADED_IMAGE_DIR, UPLOADED_IMAGE_TRASH_DIR } from "@/lib/images/image-storage";
import { previewModeGuard } from "@/lib/preview-mode";
import { isUploadedImageFilename } from "@/lib/uploaded-images";

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

  // **ゴミ箱の中も読む**（#2475）。自動削除は「いきなり消さずゴミ箱へ移す」形だが、移した瞬間に
  // ここが404になるのでは、誤判定の被害が先送りにならない（貼り付け先の画像はその場で壊れる）。
  // 読む場所を2か所にして、完全に削除されるまでは今までどおり表示できるようにしてある。
  // ファイル名の検証（`isUploadedImageFilename`）は上で1回通っているので、防波堤は変わらない。
  const buffer = await readFile(path.join(UPLOADED_IMAGE_DIR, filename))
    .catch(() => readFile(path.join(UPLOADED_IMAGE_TRASH_DIR, filename)))
    .catch(() => null);
  if (!buffer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": CONTENT_TYPE_BY_EXTENSION[extension],
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
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
  // 確認環境（`PREVIEW_MODE`）から本番の画像を消させない（#2475）。
  // 画像は`uploads/`の実ファイルで、確認環境と本番が同じディレクトリを見ることがある。
  const guard = previewModeGuard();
  if (guard) return guard;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  if (!isUploadedImageFilename(filename)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    await unlink(path.join(UPLOADED_IMAGE_DIR, filename));
  } catch (error) {
    // すでに消えている場合は、一覧を取り直せば消えるので成功と区別しない
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
