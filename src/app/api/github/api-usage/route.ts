import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { getGithubApiUsageSummary } from "@/lib/github/api-usage";

/**
 * GitHub App（REST）の消費を機能×エンドポイント別に返す（#5367）。
 * 直近60分・正時起点の現在の1時間・直近24時間を、多い順に並べる。プロセス内の計測のため、
 * 再起動直後はDBから復元した分までしか遡れない（`measuringSince`で確認できる）。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(getGithubApiUsageSummary(), { headers: { "Cache-Control": "no-store" } });
}
