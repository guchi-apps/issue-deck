import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateIssueBodyCleanup } from "@/lib/claude/issue-body-cleanup";
import { getAppAiToken } from "@/lib/claude/request";

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken();
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const body = payload?.body;

  if (typeof body !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await generateIssueBodyCleanup(token, body);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/issues/body-cleanup]", error);
    return NextResponse.json(
      {
        error: "body_cleanup_generation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
