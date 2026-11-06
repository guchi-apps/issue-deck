
import { db } from "@/lib/db";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import type { ReleaseCheckLineRecord, ReleaseCheckRecord } from "@/lib/release-check";

/**
 * リリース履歴（#2726）の母集団。「ブランチ」画面・リリース状況の取得（`release-pending-merges/route.ts`）と揃え、
 * アーカイブ済みを除いたユーザーの接続先すべてにする。**非表示リポジトリも含める**——
 * 除くのは`selectVisibleReleaseHistory`でクライアント側が行う（`release-activity.ts`と同じ方針）。
 *
 * 前回の取得結果（`ReleaseHistoryCache`。#5230）はユーザーに依らない共有の写しなので、
 * 読むときも必ずここで絞った母集団を通す。
 */
export function findReleaseHistoryRepositories(userId: string) {
  return db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });
}

export type ReleaseCheckMaterials = {
  /** repoFullName → 対象に加えた時刻（この時点まで遡って取る） */
  checkSinceMsByFullName: Map<string, number>;
  checkRecords: ReleaseCheckRecord[];
  legacyCheckLineRecords: ReleaseCheckLineRecord[];
};

/**
 * 動作確認のフラグ（#2930）の材料。**状態へ畳まずそのまま返す**——判定は
 * `lib/release-check.ts`の純粋関数が行い、画面は「確認済みにする」を押した直後も
 * 同じ関数で描き直す（サーバーの応答を待たない楽観的更新のため）。
 * 前回の取得結果を返すとき（#5230）も、確認の記録はキャッシュせず毎回ここで読む。
 */
export async function loadReleaseCheckMaterials(
  userId: string,
  repositoryIds: readonly string[],
): Promise<ReleaseCheckMaterials> {
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
      where: { repositoryId: { in: [...repositoryIds] } },
      select: {
        tagName: true,
        lineKey: true,
        checkedAt: true,
        repository: { select: { fullName: true } },
      },
    }),
  ]);

  return {
    checkSinceMsByFullName: new Map(
      checkTargetRows.map((row) => [row.repository.fullName, row.createdAt.getTime()]),
    ),
    checkRecords: checkRecordRows.map((row) => ({
      repoFullName: row.repository.fullName,
      tagName: row.tagName,
      checkedAt: row.checkedAt.toISOString(),
    })),
    legacyCheckLineRecords: checkLineRecordRows.map((row) => ({
      repoFullName: row.repository.fullName,
      tagName: row.tagName,
      lineKey: row.lineKey,
      checkedAt: row.checkedAt.toISOString(),
    })),
  };
}

/** 新方式の候補が公開した版へ、元の候補（RC-n・revision・物理PR）を付ける（#4597）。取れなければ付けない */
export async function attachReleaseCandidates(entries: ReleaseHistoryItem[]): Promise<ReleaseHistoryItem[]> {
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
    console.error("[release-history] candidate lookup failed", error);
    return entries;
  }
}

/**
 * 取得できたリポジトリぶんの一覧を前回の取得結果として残す（#5230）。失敗しても応答は止めない。
 * 候補の付け足し（`attachReleaseCandidates`）は読むたびにDBから行うので、ここには付ける前の値を入れる。
 */
export async function saveReleaseHistoryCache(
  rows: readonly { repositoryId: string; entries: readonly ReleaseHistoryItem[] }[],
): Promise<void> {
  if (rows.length === 0) return;
  const fetchedAt = new Date();
  try {
    await db.$transaction(
      rows.map((row) =>
        db.releaseHistoryCache.upsert({
          where: { repositoryId: row.repositoryId },
          create: { repositoryId: row.repositoryId, entries: row.entries as object[], fetchedAt },
          update: { entries: row.entries as object[], fetchedAt },
        }),
      ),
    );
  } catch (error) {
    console.error("[release-history] cache save failed", error);
  }
}
