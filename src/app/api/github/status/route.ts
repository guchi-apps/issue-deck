import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchGithubStatusSummary } from "@/lib/github/status";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await fetchGithubStatusSummary());
  } catch (error) {
    // GitHub管理外の公開Statuspage APIに依存しているため、失敗してもダッシュボード全体は
    // 落とさずカード内で縮退表示できるようにエラーを返すだけに留める。
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
