import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { getClaudeApiUsageSummary } from "@/lib/claude/api-usage";

/**
 * 機能別のAI API消費状況を返す（#2347）。
 * Anthropicはプラン枠の使用率しか返さないため、アプリ自身が投げた呼び出しをプロセス内で
 * 数えている（`src/lib/claude/api-usage.ts`）。このAPI自体はAnthropic APIを消費しない。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getClaudeApiUsageSummary());
}
