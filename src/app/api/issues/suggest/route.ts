import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateIssueSuggestion, type IssueSuggestLabelInput } from "@/lib/claude/issue-suggest";
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
  const labels = payload?.labels;

  if (
    typeof body !== "string" ||
    !Array.isArray(labels) ||
    !labels.every(
      (label): label is IssueSuggestLabelInput =>
        typeof label?.name === "string" && (label.description === null || typeof label.description === "string"),
    )
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await generateIssueSuggestion(token, { body, availableLabels: labels });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/issues/suggest]", error);
    return NextResponse.json(
      { error: "suggestion_generation_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
