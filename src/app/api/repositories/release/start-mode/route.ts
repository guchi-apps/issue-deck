import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleaseCallerText } from "@/lib/github/release-api";
import { decideReleaseStartMode, type ReleaseStartMode } from "@/lib/release-start-mode";

/**
 * リポジトリごとのリリース開始方式（#4604）。ブランチ画面・スマホ・一括の開始操作が、
 * 新方式（候補を作成して検証）か旧方式か、起動できないかを**同じ判定**で決めるための読み取り専用の取得。
 *
 * `?repos=owner/a,owner/b`。権限の無いリポジトリ・取得に失敗したリポジトリは`unknown`にする
 * （応答全体を失敗にせず、旧方式を黙って起動させない）。**何も起動しない。**
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repos = [
    ...new Set((request.nextUrl.searchParams.get("repos") ?? "").split(",").filter((name) => /^[\w.-]+\/[\w.-]+$/.test(name))),
  ].slice(0, 100);
  if (repos.length === 0) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rows = await db.repository.findMany({
    where: { fullName: { in: repos }, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  const byName = new Map(rows.map((row) => [row.fullName, row]));
  const unreadable: ReleaseStartMode = { mode: "unknown", label: "リポジトリへアクセスできず、新方式に対応しているか判定できません" };

  const entries = await Promise.all(
    repos.map(async (fullName): Promise<[string, ReleaseStartMode]> => {
      const row = byName.get(fullName);
      if (!row) return [fullName, unreadable];
      const [owner, repo] = fullName.split("/");
      try {
        const token = await getInstallationToken(row.installation.installationId);
        return [fullName, decideReleaseStartMode(await fetchReleaseCallerText(owner, repo, token))];
      } catch (error) {
        console.error(`[GET /api/repositories/release/start-mode] ${fullName}:`, error);
        return [fullName, unreadable];
      }
    }),
  );
  return NextResponse.json({ modes: Object.fromEntries(entries) }, { headers: { "Cache-Control": "no-store" } });
}
