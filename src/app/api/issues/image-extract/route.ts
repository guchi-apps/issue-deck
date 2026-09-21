import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateImageExtract, ImageExtractError } from "@/lib/claude/image-extract";
import { getAppAiToken } from "@/lib/claude/request";

const STATUS_BY_CODE: Record<ImageExtractError["code"], number> = {
  no_images: 400,
  too_many_images: 400,
  image_not_found: 404,
  image_too_large: 413,
  nothing_extracted: 422,
};

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken("issue_image_extract");
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const images = payload?.images;

  if (!Array.isArray(images) || !images.every((image): image is string => typeof image === "string")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await generateImageExtract(token, images);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ImageExtractError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: STATUS_BY_CODE[error.code] },
      );
    }
    console.error("[POST /api/issues/image-extract]", error);
    return NextResponse.json(
      {
        error: "image_extract_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
