import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";

/** dispatchしてからGitHub上でrunが見えるまでの空白を覆う時間。長すぎると、実行が終わった直後の次の開始を止める */
export const RELEASE_START_LOCK_TTL_MS = 60_000;

/**
 * リポジトリ単位の開始要求を確保する。**確保できたら確保時刻（手放すときの所有者の印）**、他の要求が保持中なら`null`。
 * 主キーの一意性で同時の確保を1件に絞り、期限切れの行だけを条件付きで取り直す。
 */
export async function acquireReleaseStartLock(repositoryFullName: string, now: Date = new Date()): Promise<Date | null> {
  const data = { repositoryFullName, acquiredAt: now, expiresAt: new Date(now.getTime() + RELEASE_START_LOCK_TTL_MS) };
  // 作成に負けた後、保持者が先に手放して行が消えていたら作り直す（誤って「保持中」と返さない）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.releaseStartLock.create({ data });
      return now;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
    // 期限切れの行だけを取り直す（`updateMany`の条件付き更新が競合を1件に絞る）
    const taken = await db.releaseStartLock.updateMany({
      where: { repositoryFullName, expiresAt: { lte: now } },
      data: { acquiredAt: data.acquiredAt, expiresAt: data.expiresAt },
    });
    if (taken.count === 1) return now;
    if ((await db.releaseStartLock.count({ where: { repositoryFullName } })) > 0) return null;
  }
  return null;
}

/**
 * 開始しなかった（確認の結果止めた・dispatchに失敗した）要求の確保を手放す。
 * **自分が確保した行（`acquiredAt`が一致）だけ**を消す。処理が期限を超えて他の要求が取り直した後に、その行を消さないため
 */
export async function releaseReleaseStartLock(repositoryFullName: string, acquiredAt: Date): Promise<void> {
  await db.releaseStartLock.deleteMany({ where: { repositoryFullName, acquiredAt } }).catch((error: unknown) => {
    console.error("[release-start-lock] release failed", repositoryFullName, error);
  });
}
