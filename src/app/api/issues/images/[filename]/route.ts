import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "images");

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// アップロードAPI（route.ts）が発行するUUIDファイル名の形式のみ許可し、パストラバーサルを防ぐ。
const FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  if (!FILENAME_PATTERN.test(filename)) {
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
