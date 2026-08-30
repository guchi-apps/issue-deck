import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { getLatestCodexUsage } from "@/lib/dispatch/codex-usage";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const usage = await getLatestCodexUsage();
  if (!usage) return NextResponse.json({ error: "not_reported" }, { status: 501 });
  return NextResponse.json(usage, { headers: { "Cache-Control": "no-store" } });
}
