import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";

/** dispatchしてからGitHub上でrunが見えるまでの空白を覆う時間。長すぎると、実行が終わった直後の次の開始を止める */
export const RELEASE_START_LOCK_TTL_MS = 60_000;

/**
 * リポジトリ単位の開始要求を確保する。**確保できたら`true`**、他の要求が保持中なら`false`。
 * 主キーの一意性で同時の確保を1件に絞り、期限切れの行だけを条件付きで取り直す。
 */
export async function acquireReleaseStartLock(repositoryFullName: string, now: Date = new Date()): Promise<boolean> {
  const data = { repositoryFullName, acquiredAt: now, expiresAt: new Date(now.getTime() + RELEASE_START_LOCK_TTL_MS) };
  try {
    await db.releaseStartLock.create({ data });
    return true;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }
  // 期限切れの行だけを取り直す（`updateMany`の条件付き更新が競合を1件に絞る）
  const taken = await db.releaseStartLock.updateMany({
    where: { repositoryFullName, expiresAt: { lte: now } },
    data: { acquiredAt: data.acquiredAt, expiresAt: data.expiresAt },
  });
  return taken.count === 1;
}

/** 開始しなかった（確認の結果止めた・dispatchに失敗した）要求の確保を手放す */
export async function releaseReleaseStartLock(repositoryFullName: string): Promise<void> {
  await db.releaseStartLock.deleteMany({ where: { repositoryFullName } }).catch((error: unknown) => {
    console.error("[release-start-lock] release failed", repositoryFullName, error);
  });
}
