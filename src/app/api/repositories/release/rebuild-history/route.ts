import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listRebuildEpisodes } from "@/lib/release-rebuild-history-run";

/**
 * リリース候補の作り直しの操作履歴（#4359）。DBだけを読み、GitHub APIは叩かない
 * （PCのブランチ画面が追加のGitHub API取得をしない前提を守る）。
 * 元候補・承認した範囲・実際に取り込んだ範囲・含めなかった範囲・後継候補を経過ごとに返す。
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    select: { id: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const episodes = await listRebuildEpisodes(`${owner}/${repo}`);
  return NextResponse.json({ episodes }, { headers: { "Cache-Control": "no-store" } });
}
