import {
  type ClaudeApiFeature,
  type ClaudeApiUsageBucketSnapshot,
  loadPersistedBuckets,
  USAGE_WINDOW_MS,
} from "@/lib/claude/api-usage";
import { db } from "@/lib/db";

/**
 * 起動時にDBから直近7日ぶんの計測データを読み込み、`api-usage.ts`のメモリへ復元する。
 * DB接続に失敗してもアプリの起動自体は落とさず、console.errorのみに留めてメモリ空のまま続行する。
 */
export async function hydrateClaudeApiUsageFromDb(now: number = Date.now()): Promise<void> {
  try {
    const rows = await db.claudeApiUsageBucket.findMany({
      where: { startedAt: { gte: new Date(now - USAGE_WINDOW_MS) } },
    });

    const bucketsByStartedAt = new Map<number, ClaudeApiUsageBucketSnapshot>();
    for (const row of rows) {
      const startedAt = row.startedAt.getTime();
      const bucket = bucketsByStartedAt.get(startedAt) ?? { startedAt, entries: [] };
      bucket.entries.push({
        feature: row.feature as ClaudeApiFeature,
        model: row.model,
        calls: row.calls,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      });
      bucketsByStartedAt.set(startedAt, bucket);
    }

    loadPersistedBuckets([...bucketsByStartedAt.values()], now);
  } catch (error) {
    console.error("[claude/api-usage-persistence] failed to hydrate usage from DB", error);
  }
}

/**
 * バケットの現在の中身をDBへupsertする。`onBucketUpdated`からfire-and-forgetで呼ばれる想定
 * （呼び出しのたびに走る）で、失敗してもアプリの動作へは影響させずconsole.errorのみに留める。
 * あわせて保持期間より古い行を削除し、テーブルの肥大化を防ぐ。
 */
export async function flushBucketToDb(
  bucket: ClaudeApiUsageBucketSnapshot,
  now: number = Date.now(),
): Promise<void> {
  try {
    const startedAt = new Date(bucket.startedAt);
    await db.$transaction([
      ...bucket.entries.map((entry) =>
        db.claudeApiUsageBucket.upsert({
          where: {
            startedAt_feature_model: { startedAt, feature: entry.feature, model: entry.model },
          },
          create: {
            startedAt,
            feature: entry.feature,
            model: entry.model,
            calls: entry.calls,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            cacheCreationTokens: entry.cacheCreationTokens,
          },
          update: {
            calls: entry.calls,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            cacheCreationTokens: entry.cacheCreationTokens,
          },
        }),
      ),
      db.claudeApiUsageBucket.deleteMany({
        where: { startedAt: { lt: new Date(now - USAGE_WINDOW_MS) } },
      }),
    ]);
  } catch (error) {
    console.error("[claude/api-usage-persistence] failed to flush usage bucket to DB", error);
  }
}

/**
 * 累計入力トークン数へ1件ぶんを加算する（#3500）。`onCallRecorded`からfire-and-forgetで呼ばれる想定で、
 * 失敗してもアプリの動作へは影響させずconsole.errorのみに留める。DB側で`increment`するため、
 * 再起動や複数プロセスをまたいでも減らない。
 */
export async function addCumulativeInputTokens(model: string, inputTokens: number): Promise<void> {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
  const amount = BigInt(Math.trunc(inputTokens));
  try {
    await db.claudeApiUsageCumulative.upsert({
      where: { model },
      create: { model, inputTokens: amount },
      update: { inputTokens: { increment: amount } },
    });
  } catch (error) {
    console.error("[claude/api-usage-persistence] failed to add cumulative input tokens", error);
  }
}

/** モデル別の累計入力トークン数をDBから読む。失敗したら`null`を返す。 */
export async function readCumulativeInputTokens(): Promise<Map<string, number> | null> {
  try {
    const rows = await db.claudeApiUsageCumulative.findMany();
    return new Map(rows.map((row) => [row.model, Number(row.inputTokens)]));
  } catch (error) {
    console.error("[claude/api-usage-persistence] failed to read cumulative input tokens", error);
    return null;
  }
}
