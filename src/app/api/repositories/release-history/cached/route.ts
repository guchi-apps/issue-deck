import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import { buildCheckLineRecordsFromBodies } from "@/lib/release-body-tasks";
import { mergeReleaseHistory } from "@/lib/release-history";
import {
  attachReleaseCandidates,
  findReleaseHistoryRepositories,
  loadReleaseCheckMaterials,
} from "@/lib/release-history-server";

/**
 * リリース履歴の前回の取得結果（#5230）。**GitHubを呼ばない**ので、画面を開いた直後に出せる。
 *
 * 一覧はリポジトリごとの写し（`ReleaseHistoryCache`）から組み、確認の記録はキャッシュせず
 * 毎回DBから読む。写しはユーザーに依らない共有のものなので、母集団は本体の
 * `release-history`と同じ絞り込み（`findReleaseHistoryRepositories`）を通してから読む。
 *
 * `fetchedAt`は返したリポジトリのうち最も古い取得時刻（帯に「前回取得 ◯時◯分」と出す）。
 * 写しが1件も無ければ`fetchedAt: null`で、画面は従来どおりスケルトンを出して最新を待つ。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositories = await findReleaseHistoryRepositories(userId);
  if (repositories.length === 0) {
    return NextResponse.json({ repositories: [], entries: [], checkRecords: [], checkLineRecords: [], fetchedAt: null });
  }

  const [caches, { checkRecords, legacyCheckLineRecords }] = await Promise.all([
    db.releaseHistoryCache.findMany({
      where: { repositoryId: { in: repositories.map((repository) => repository.id) } },
      select: { entries: true, fetchedAt: true, repository: { select: { fullName: true } } },
    }),
    loadReleaseCheckMaterials(
      userId,
      repositories.map((repository) => repository.id),
    ),
  ]);

  const entries = await attachReleaseCandidates(
    mergeReleaseHistory(caches.map((cache) => (Array.isArray(cache.entries) ? (cache.entries as unknown as ReleaseHistoryItem[]) : []))),
  );
  const oldest = caches.reduce<Date | null>(
    (min, cache) => (min === null || cache.fetchedAt < min ? cache.fetchedAt : min),
    null,
  );

  return NextResponse.json({
    repositories: caches.map((cache) => cache.repository.fullName),
    entries,
    checkRecords,
    checkLineRecords: buildCheckLineRecordsFromBodies(entries, legacyCheckLineRecords),
    fetchedAt: oldest?.toISOString() ?? null,
  });
}
