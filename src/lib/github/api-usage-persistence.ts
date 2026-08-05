import { db } from "@/lib/db";
import {
  type ClosedGithubApiUsageBucket,
  type GithubApiFeature,
  loadPersistedBuckets,
  USAGE_WINDOW_MS,
} from "@/lib/github/api-usage";

/**
 * 起動時にDBから直近24時間ぶんの計測データを読み込み、`api-usage.ts`のメモリへ復元する。
 * DB接続に失敗してもアプリの起動自体は落とさず、console.errorのみに留めてメモリ空のまま続行する。
 */
export async function hydrateGithubApiUsageFromDb(now: number = Date.now()): Promise<void> {
  try {
    const rows = await db.githubApiUsageBucket.findMany({
      where: { startedAt: { gte: new Date(now - USAGE_WINDOW_MS) } },
    });

    const bucketsByStartedAt = new Map<number, ClosedGithubApiUsageBucket>();
    for (const row of rows) {
      const startedAt = row.startedAt.getTime();
      const bucket = bucketsByStartedAt.get(startedAt) ?? { startedAt, entries: [] };
      bucket.entries.push({
        feature: row.feature as GithubApiFeature,
        endpoint: row.endpoint,
        count: row.count,
      });
      bucketsByStartedAt.set(startedAt, bucket);
    }

    loadPersistedBuckets([...bucketsByStartedAt.values()], now);
  } catch (error) {
    console.error("[github/api-usage-persistence] failed to hydrate usage from DB", error);
  }
}

/**
 * 閉じたバケットの内容をDBへupsertする。`onBucketClosed`からfire-and-forgetで呼ばれる想定で、
 * 失敗してもアプリの動作へは影響させずconsole.errorのみに留める。あわせて24時間より古い行を削除し、
 * テーブルの肥大化を防ぐ。
 */
export async function flushBucketToDb(bucket: ClosedGithubApiUsageBucket, now: number = Date.now()): Promise<void> {
  try {
    const startedAt = new Date(bucket.startedAt);
    await db.$transaction([
      ...bucket.entries.map((entry) =>
        db.githubApiUsageBucket.upsert({
          where: {
            startedAt_feature_endpoint: { startedAt, feature: entry.feature, endpoint: entry.endpoint },
          },
          create: { startedAt, feature: entry.feature, endpoint: entry.endpoint, count: entry.count },
          update: { count: entry.count },
        }),
      ),
      db.githubApiUsageBucket.deleteMany({ where: { startedAt: { lt: new Date(now - USAGE_WINDOW_MS) } } }),
    ]);
  } catch (error) {
    console.error("[github/api-usage-persistence] failed to flush usage bucket to DB", error);
  }
}
