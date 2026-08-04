import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchClaudeRateLimit } from "@/lib/claude/rate-limit";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const rateLimit = await fetchClaudeRateLimit(apiKey);
  return NextResponse.json(rateLimit);
}
