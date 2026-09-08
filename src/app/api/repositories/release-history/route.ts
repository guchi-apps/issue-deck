import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRecentReleases, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { hasReachedReleaseCheckSince, type ReleaseCheckRecord } from "@/lib/release-check";
import { mergeReleaseHistory } from "@/lib/release-history";

/** リポジトリ1件あたりの取得件数（#2726）。フリート全体でも数百件程度に収まる想定 */
const PER_REPOSITORY_LIMIT = 20;

/**
 * 動作確認の対象リポジトリで、基準時刻（`ReleaseCheckTarget.createdAt`）へ届くまで
 * 遡ってよいページ数の上限（#2930）。
 *
 * **1ページ（20件）は、リリースの多いリポジトリでは数日ぶりにしかならない。** issue-deck自身は
 * 直近7日で22件リリースしており、1ページだと約6日ぶんしか見えない。確認を1週間サボると、
 * 未確認のカードが一覧から静かに落ち、「未確認 N件」からも消える——いちばん漏れやすい
 * ケース（放置したリリース）で機能しなくなる。
 *
 * 遡るのは対象リポジトリだけで、しかも**基準時刻より古いリリースが1件出た時点で止める**ので、
 * 対象に加えた直後は1ページで済む。ページが伸びるのは確認を溜めているあいだだけ。
 * この上限（5ページ＝100件）はissue-deckの実測で約1か月ぶんにあたる。
 */
const MAX_PAGES_FOR_CHECK_TARGET = 5;

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

  // repoFullName → 対象に加えた時刻（この時点まで遡って取る）
  const checkSinceMsByFullName = new Map(
    checkTargetRows.map((row) => [row.repository.fullName, row.createdAt.getTime()]),
  );
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
        const sinceMs = checkSinceMsByFullName.get(repository.fullName);
        return await fetchReleasesBackTo(repository.ownerLogin, repository.name, token, sinceMs);
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return [];
      }
    }),
  );

  return NextResponse.json({ entries: mergeReleaseHistory(perRepository), checkRecords });
}

/**
 * 1リポジトリぶんのリリースを取る。`sinceMs`（動作確認の基準時刻）が渡されたときだけ、
 * それより古いリリースへ届くまでページを足す（上限`MAX_PAGES_FOR_CHECK_TARGET`）。
 *
 * **対象でないリポジトリは従来どおり1ページ。** 未確認のフラグが付かないので、遡っても
 * GitHub APIを余計に叩くだけになる。
 */
async function fetchReleasesBackTo(
  owner: string,
  repo: string,
  token: string,
  sinceMs: number | undefined,
): Promise<ReleaseHistoryItem[]> {
  const first = await fetchRecentReleases(owner, repo, token, PER_REPOSITORY_LIMIT);
  if (sinceMs === undefined || first.length < PER_REPOSITORY_LIMIT) return first;

  const collected = [...first];
  for (let page = 2; page <= MAX_PAGES_FOR_CHECK_TARGET; page += 1) {
    // 一覧は公開日時の新しい順なので、末尾が基準より古ければその先はすべて対象外。
    if (hasReachedReleaseCheckSince(collected, sinceMs)) break;
    const next = await fetchRecentReleases(owner, repo, token, PER_REPOSITORY_LIMIT, page);
    if (next.length === 0) break;
    collected.push(...next);
    if (next.length < PER_REPOSITORY_LIMIT) break;
  }
  return collected;
}

