import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleasesBackTo, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { appendUnreleasedVersions } from "@/lib/github/unreleased-versions";
import {
  hasReachedReleaseCheckSince,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
} from "@/lib/release-check";
import { buildCheckLineRecordsFromBodies } from "@/lib/release-body-tasks";
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
    // 旧記録（ユーザーごとのDB。#4374）。確認状態の正はGitHub Release本文のタスクリストで、
    // ここはまだタスクリストになっていない行のフォールバックにだけ使う。複数ユーザーぶんは
    // 和集合（誰かが確認していれば確認済み）で、`buildCheckLineRecordsFromBodies`が畳む
    db.releaseCheckLine.findMany({
      where: { repositoryId: { in: repositories.map((repository) => repository.id) } },
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
  const legacyCheckLineRecords: ReleaseCheckLineRecord[] = checkLineRecordRows.map((row) => ({
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
        // GitHub Releaseが無い版（本番デプロイの失敗など）をタグから補い、修正版と紐付ける（#4003）
        // iOS配布の状況はここで待たない。1回約1MB・約3秒かかるため、`release-history/ios-status`で後から重ねる（#5214）
        return await appendUnreleasedVersions(repository.ownerLogin, repository.name, token, releases);
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return [];
      }
    }),
  );

  const entries = await attachReleaseCandidates(mergeReleaseHistory(perRepository));
  return NextResponse.json({
    entries,
    checkRecords,
    // 項目ごとの確認状態はGitHub Release本文のタスクリストが正（#4374）。取得のたびに本文から組み直す
    checkLineRecords: buildCheckLineRecordsFromBodies(entries, legacyCheckLineRecords),
  });
}

/** 新方式の候補が公開した版へ、元の候補（RC-n・revision・物理PR）を付ける（#4597）。取れなければ付けない */
async function attachReleaseCandidates(entries: ReleaseHistoryItem[]): Promise<ReleaseHistoryItem[]> {
  if (entries.length === 0) return entries;
  try {
    const rows = await db.releaseVersionReservation.findMany({
      where: { repositoryFullName: { in: [...new Set(entries.map((entry) => entry.repoFullName))] }, status: "consumed" },
      select: {
        repositoryFullName: true,
        version: true,
        consumedTag: true,
        candidate: {
          select: {
            sequence: true,
            currentRevision: true,
            revisions: { where: { prNumber: { not: null } }, orderBy: { revision: "desc" }, take: 1, select: { prNumber: true } },
          },
        },
      },
    });
    const byTag = new Map<string, (typeof rows)[number]>();
    for (const row of rows) byTag.set(`${row.repositoryFullName} ${row.consumedTag ?? `v${row.version}`}`, row);
    return entries.map((entry) => {
      const row = byTag.get(`${entry.repoFullName} ${entry.tagName}`);
      if (!row) return entry;
      return {
        ...entry,
        releaseCandidate: { sequence: row.candidate.sequence, revision: row.candidate.currentRevision, prNumber: row.candidate.revisions[0]?.prNumber ?? null },
      };
    });
  } catch (error) {
    console.error("[GET /api/repositories/release-history] candidate lookup failed", error);
    return entries;
  }
}
