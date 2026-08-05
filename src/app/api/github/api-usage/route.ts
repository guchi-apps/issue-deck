import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { getGithubApiUsageSummary } from "@/lib/github/api-usage";

/**
 * 用途別のGitHub API消費状況を返す。
 * GitHubは消費の内訳を返さないため、アプリ自身が発信したリクエストをプロセス内で数えている
 * （`src/lib/github/api-usage.ts`）。このAPI自体はGitHub APIを消費しない。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getGithubApiUsageSummary());
}
