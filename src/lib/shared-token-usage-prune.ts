import { db } from "@/lib/db";

/** 共有トークンの利用記録（`SharedTokenUsage`）を残す日数。これより古い行は巡回で消す（#4165）。 */
export const SHARED_TOKEN_USAGE_RETENTION_DAYS = 180;

export async function pruneOldSharedTokenUsages(now: Date): Promise<number> {
  const before = new Date(now.getTime() - SHARED_TOKEN_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db.sharedTokenUsage.deleteMany({ where: { usedAt: { lt: before } } });
  return deleted.count;
}
