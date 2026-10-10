import { decideAccess } from "@/lib/access/client";
import { db } from "@/lib/db";

import { extractShareToken, hashShareToken } from "./token";

/**
 * 共有トークンの検証（#4298）。有効（未失効・期限内）で、持ち主が今も許可されていれば返す。
 * **検証のたびに許可判定（`decideAccess`。応答は判定側のTTLでキャッシュされる）を通す**。
 * Cookie認証の`getCurrentUser`と同じ最終防御線で、許可リストから外れた利用者は発行済みトークンでも通さない。
 */
export async function authenticateShareToken(authorization: string | null) {
  const value = extractShareToken(authorization);
  if (!value) return null;
  const token = await db.shareToken.findUnique({
    where: { tokenHash: hashShareToken(value) },
    include: { user: true },
  });
  if (!token || token.revokedAt || token.expiresAt <= new Date()) return null;
  const decision = await decideAccess({
    sub: token.user.supabaseUserId,
    email: token.user.email ?? "",
    emailVerified: token.emailVerified,
  });
  if (!decision.allowed) return null;
  await db.shareToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return token.user;
}
