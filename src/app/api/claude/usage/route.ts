import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchClaudeUsage } from "@/lib/claude/usage";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    return NextResponse.json(await fetchClaudeUsage(token));
  } catch (error) {
    // 非公開エンドポイントに依存しているため、失敗してもダッシュボード全体は落とさず
    // カード内で縮退表示できるようにエラーを返すだけに留める。
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
