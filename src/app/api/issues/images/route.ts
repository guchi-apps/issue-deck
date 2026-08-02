import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { getRequestOrigin } from "@/lib/request-origin";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "images");

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
