import { db } from "@/lib/db";

import { extractShareToken, hashShareToken } from "./token";

/**
 * 共有トークンの検証（#4298）。有効（未失効・期限内）なら持ち主のユーザーを返す。
 * 許可リストから外れたユーザーは通さない（Cookie認証の`getCurrentUser`と同じ最終防御線）。
 */
export async function authenticateShareToken(authorization: string | null) {
  const value = extractShareToken(authorization);
  if (!value) return null;
  const token = await db.shareToken.findUnique({
    where: { tokenHash: hashShareToken(value) },
    include: { user: true },
  });
  if (!token || token.revokedAt || token.expiresAt <= new Date()) return null;
  await db.shareToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return token.user;
}
