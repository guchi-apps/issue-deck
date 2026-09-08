import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRecentReleases, type ReleaseHistoryItem } from "@/lib/github/release-api";
import type { ReleaseCheckRecord, ReleaseCheckTargetSummary } from "@/lib/release-check";
import { mergeReleaseHistory } from "@/lib/release-history";

/** リポジトリ1件あたりの取得件数（#2726）。フリート全体でも数百件程度に収まる想定 */
const PER_REPOSITORY_LIMIT = 20;

export function GET() {
  return withGithubApiFeature("release_history", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 母集団は「ブランチ」画面・リリース状況の取得（`release-pending-merges/route.ts`）と揃え、
  // アーカイブ済みを除いたユーザーの接続先すべてにする。**非表示リポジトリも含める**——
  // 除くのは`selectVisibleReleaseHistory`でクライアント側が行う（`release-activity.ts`と同じ方針）。
  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    return NextResponse.json({ entries: [], checkTargets: [], checkRecords: [] });
  }

  // 動作確認のフラグ（#2930）の材料。**状態へ畳まずそのまま返す**——判定は
  // `lib/release-check.ts`の純粋関数が行い、画面は「確認済みにする」を押した直後も
  // 同じ関数で描き直す（サーバーの応答を待たない楽観的更新のため）。
  const [checkTargetRows, checkRecordRows] = await Promise.all([
    db.releaseCheckTarget.findMany({
      where: { userId },
      select: { createdAt: true, repository: { select: { fullName: true } } },
    }),
    db.releaseCheck.findMany({
      where: { userId },
      select: { tagName: true, checkedAt: true, repository: { select: { fullName: true } } },
    }),
  ]);

  const checkTargets: ReleaseCheckTargetSummary[] = checkTargetRows.map((row) => ({
    repoFullName: row.repository.fullName,
    since: row.createdAt.toISOString(),
  }));
  const checkRecords: ReleaseCheckRecord[] = checkRecordRows.map((row) => ({
    repoFullName: row.repository.fullName,
    tagName: row.tagName,
    checkedAt: row.checkedAt.toISOString(),
  }));

  // 同一installationのリポジトリ間でトークン取得を使い回す（`release-pending-merges`と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const perRepository = await Promise.all(
    repositories.map(async (repository): Promise<ReleaseHistoryItem[]> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        return await fetchRecentReleases(
          repository.ownerLogin,
          repository.name,
          token,
          PER_REPOSITORY_LIMIT,
        );
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return [];
      }
    }),
  );

  return NextResponse.json({
    entries: mergeReleaseHistory(perRepository),
    checkTargets,
    checkRecords,
  });
}
