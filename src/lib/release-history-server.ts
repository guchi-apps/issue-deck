
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { describeGithubError } from "@/lib/github/forbidden-cause";
import { fetchReleasesBackTo, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { appendUnreleasedVersions } from "@/lib/github/unreleased-versions";
import {
  hasReachedReleaseCheckSince,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
} from "@/lib/release-check";

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

/**
 * 写しを正として返す期間（#5392）。これを過ぎたリポジトリだけ、読むときにGitHubから取り直す。
 * Webhook（`release`イベント）と本文更新の書き戻しで多くは鮮度内に保たれるが、タグだけの版
 * （Releaseが無い失敗版）は`release`イベントで変化を受けられないため、この期間が最大の遅れになる。
 */
export const RELEASE_HISTORY_CACHE_TTL_MS = 15 * 60 * 1000;

export function isReleaseHistoryCacheFresh(
  fetchedAt: Date,
  nowMs: number,
  ttlMs: number = RELEASE_HISTORY_CACHE_TTL_MS,
): boolean {
  return nowMs - fetchedAt.getTime() < ttlMs;
}

/**
 * リポジトリごとの、遡って取る基準時刻（全ユーザーの`ReleaseCheckTarget.createdAt`の最小値）。
 * 写しはユーザーに依らない共有のもので、取得時のユーザーを持たないWebhook・TTLの再取得でも
 * 確認対象の過去の未確認リリースが写しから消えないよう、最も古い対象に合わせて取る。
 * 確認対象が無いリポジトリは載らず、従来どおり1ページだけ取る。
 */
export async function findMinCheckSinceMsByRepositoryId(
  repositoryIds: readonly string[],
): Promise<Map<string, number>> {
  if (repositoryIds.length === 0) return new Map();
  const rows = await db.releaseCheckTarget.groupBy({
    by: ["repositoryId"],
    where: { repositoryId: { in: [...repositoryIds] } },
    _min: { createdAt: true },
  });
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row._min.createdAt) result.set(row.repositoryId, row._min.createdAt.getTime());
  }
  return result;
}

export type ReleaseHistoryRepository = {
  id: string;
  fullName: string;
  ownerLogin: string;
  name: string;
  installation: { installationId: number };
};

/**
 * 1リポジトリのリリース履歴をGitHubから取り直して写しへ保存する。失敗したら例外を投げる
 * （写しは前回のまま残る）。画面の取得・Webhookが同じこの経路を通り、取得の深さを1か所で決める。
 */
export async function refreshReleaseHistoryForRepository(
  repository: ReleaseHistoryRepository,
  token: string,
  sinceMs?: number,
): Promise<ReleaseHistoryItem[]> {
  const resolvedSinceMs =
    sinceMs !== undefined ? sinceMs : (await findMinCheckSinceMsByRepositoryId([repository.id])).get(repository.id);
  const releases = await fetchReleasesBackTo(
    repository.ownerLogin,
    repository.name,
    token,
    resolvedSinceMs,
    hasReachedReleaseCheckSince,
  );
  // GitHub Releaseが無い版（本番デプロイの失敗など）をタグから補い、修正版と紐付ける（#4003）
  // iOS配布の状況はここで待たない（`release-history/ios-status`で後から重ねる。#5214）
  const entries = await appendUnreleasedVersions(repository.ownerLogin, repository.name, token, releases);
  await saveReleaseHistoryCache([{ repositoryId: repository.id, entries }]);
  return entries;
}

export type LoadedReleaseHistory = {
  repositoryId: string;
  fullName: string;
  entries: ReleaseHistoryItem[];
  /** GitHubから取り直したか（falseは写しをそのまま返した） */
  refreshed: boolean;
};

/**
 * 写しを正としてリポジトリぶんの履歴を返す（#5392）。写しが無い・鮮度（TTL）を過ぎた・`refresh`の
 * リポジトリだけGitHubから取り直す。取り直しに失敗したリポジトリは`failed`へ入れ、前回の値は返さない
 * （画面は前回の値を残してロックする）。
 */
export async function loadReleaseHistoryFromCache(
  repositories: readonly ReleaseHistoryRepository[],
  options: { refresh: boolean; nowMs?: number },
): Promise<{
  loaded: LoadedReleaseHistory[];
  failed: { repositoryId: string; fullName: string; reason: string }[];
  durations: { fullName: string; ms: number }[];
}> {
  const nowMs = options.nowMs ?? Date.now();
  const [caches, sinceByRepositoryId] = await Promise.all([
    db.releaseHistoryCache.findMany({
      where: { repositoryId: { in: repositories.map((repository) => repository.id) } },
      select: { repositoryId: true, entries: true, fetchedAt: true },
    }),
    findMinCheckSinceMsByRepositoryId(repositories.map((repository) => repository.id)),
  ]);
  const cacheByRepositoryId = new Map(caches.map((cache) => [cache.repositoryId, cache]));

  // 同一installationのリポジトリ間でトークン取得を使い回す
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const durations: { fullName: string; ms: number }[] = [];
  const failed: { repositoryId: string; fullName: string; reason: string }[] = [];
  const results = await Promise.all(
    repositories.map(async (repository): Promise<LoadedReleaseHistory | null> => {
      const cache = cacheByRepositoryId.get(repository.id);
      if (!options.refresh && cache && Array.isArray(cache.entries) && isReleaseHistoryCacheFresh(cache.fetchedAt, nowMs)) {
        return {
          repositoryId: repository.id,
          fullName: repository.fullName,
          entries: cache.entries as unknown as ReleaseHistoryItem[],
          refreshed: false,
        };
      }
      const startedAt = performance.now();
      try {
        const token = await tokenFor(repository.installation.installationId);
        const entries = await refreshReleaseHistoryForRepository(
          repository,
          token,
          sinceByRepositoryId.get(repository.id),
        );
        return { repositoryId: repository.id, fullName: repository.fullName, entries, refreshed: true };
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない
        console.error(`[release-history] ${repository.fullName}:`, error);
        failed.push({
          repositoryId: repository.id,
          fullName: repository.fullName,
          reason: describeGithubError(error) ?? "",
        });
        return null;
      } finally {
        durations.push({ fullName: repository.fullName, ms: Math.round(performance.now() - startedAt) });
      }
    }),
  );
  return { loaded: results.filter((row) => row !== null), failed, durations };
}

/**
 * Release本文を書き換えたあと、写しの該当版の本文だけを差し替える（#5392）。確認状態の正は
 * Release本文のタスクリスト（#4374）で、写しが古い本文のままだと、鮮度内の再表示で押した
 * チェックが戻って見える。GitHubは呼ばない。写しが無ければ何もしない。失敗しても応答は止めない。
 */
export async function patchReleaseHistoryCacheBody(
  repositoryId: string,
  tagName: string,
  body: string | null,
): Promise<void> {
  try {
    const cache = await db.releaseHistoryCache.findUnique({
      where: { repositoryId },
      select: { entries: true },
    });
    if (!cache || !Array.isArray(cache.entries)) return;
    const entries = cache.entries as unknown as ReleaseHistoryItem[];
    if (!entries.some((entry) => entry.tagName === tagName)) return;
    await db.releaseHistoryCache.update({
      where: { repositoryId },
      data: { entries: entries.map((entry) => (entry.tagName === tagName ? { ...entry, body } : entry)) as object[] },
    });
  } catch (error) {
    console.error("[release-history] cache body patch failed", error);
  }
}
