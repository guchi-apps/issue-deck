import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleasesBackTo, fetchTagRefs, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { IOS_TESTFLIGHT_TAG_PREFIX, iosDeliveryForReleases } from "@/lib/ios-testflight-status";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";
import {
  hasReachedReleaseCheckSince,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
} from "@/lib/release-check";
import { mergeReleaseHistory } from "@/lib/release-history";

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
    return NextResponse.json({ entries: [], checkTargets: [], checkRecords: [], checkLineRecords: [] });
  }

  // 動作確認のフラグ（#2930）の材料。**状態へ畳まずそのまま返す**——判定は
  // `lib/release-check.ts`の純粋関数が行い、画面は「確認済みにする」を押した直後も
  // 同じ関数で描き直す（サーバーの応答を待たない楽観的更新のため）。
  // 箇条書き行ごとの確認記録（#2982）も同じ材料の一つとして返す。
  const [checkTargetRows, checkRecordRows, checkLineRecordRows] = await Promise.all([
    db.releaseCheckTarget.findMany({
      where: { userId },
      select: { createdAt: true, repository: { select: { fullName: true } } },
    }),
    db.releaseCheck.findMany({
      where: { userId },
      select: { tagName: true, checkedAt: true, repository: { select: { fullName: true } } },
    }),
    db.releaseCheckLine.findMany({
      where: { userId },
      select: {
        tagName: true,
        lineKey: true,
        checkedAt: true,
        repository: { select: { fullName: true } },
      },
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
  const checkLineRecords: ReleaseCheckLineRecord[] = checkLineRecordRows.map((row) => ({
    repoFullName: row.repository.fullName,
    tagName: row.tagName,
    lineKey: row.lineKey,
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
        const releases = await fetchReleasesBackTo(
          repository.ownerLogin,
          repository.name,
          token,
          sinceMs,
          hasReachedReleaseCheckSince,
        );
        // TestFlight配布対象のリポジトリだけ、配布済みのビルド番号を付ける（#3800）
        if (getWebviewIosRepository(repository.fullName) === null || releases.length === 0) return releases;
        const [versionRefs, deliveredRefs] = await Promise.all([
          fetchTagRefs(repository.ownerLogin, repository.name, token, "v"),
          fetchTagRefs(repository.ownerLogin, repository.name, token, IOS_TESTFLIGHT_TAG_PREFIX),
        ]);
        const delivered = iosDeliveryForReleases(
          releases.map((release) => release.tagName),
          versionRefs,
          deliveredRefs,
        );
        return releases.map((release) => {
          const build = delivered.get(release.tagName);
          return build === undefined ? release : { ...release, iosDeliveredBuild: build };
        });
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return [];
      }
    }),
  );

  return NextResponse.json({
    entries: mergeReleaseHistory(perRepository),
    checkRecords,
    checkLineRecords,
  });
}
