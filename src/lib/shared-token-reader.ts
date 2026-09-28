import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";

/** 利用記録（`SharedTokenUsage`）へ残す、issue-deck自身の利用元名。 */
export const SHARED_TOKEN_SELF_CONSUMER = "issue-deck";

const CACHE_TTL_MS = 60_000;

type CacheEntry = { value: string | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** テスト用にキャッシュを破棄する。 */
export function clearSharedTokenReaderCache() {
  cache.clear();
}

/**
 * 共有トークンの値を、自分のDBから名前で読む（#3561）。
 *
 * issue-deckは共有トークンの保存先なので、共有トークンAPIを経由せずDBから直接復号する。
 * 取得結果（無い・失敗を含む）は短時間メモリへ置き、DBを読んだ時点で`issue-deck`の利用記録を1件残す
 * （記録の頻度はキャッシュ単位）。**DB・復号の失敗は例外にせずnullで返し**、呼び出し側が環境変数へ倒せるようにする。
 */
export async function readSharedTokenValue(name: string, now = Date.now()): Promise<string | null> {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: string | null = null;
  try {
    const row = await db.sharedToken.findUnique({ where: { name } });
    if (row) {
      value = decryptSecret(row.encryptedValue);
      await db.sharedTokenUsage
        .create({ data: { sharedTokenId: row.id, consumer: SHARED_TOKEN_SELF_CONSUMER, action: "read" } })
        .catch((cause: unknown) => console.error(`共有トークン${name}の利用記録を残せませんでした`, cause));
    }
  } catch (cause) {
    console.error(`共有トークン${name}を読めませんでした。環境変数へ倒します`, cause);
    value = null;
  }
  cache.set(name, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * 共有トークンを優先し、取得できなければ環境変数へフォールバックして返す。
 * どちらも無ければundefined（呼び出し側が「未設定」として扱う）。
 */
export async function resolveSharedToken(name: string, envName: string): Promise<string | undefined> {
  const shared = (await readSharedTokenValue(name))?.trim();
  if (shared) return shared;
  return process.env[envName]?.trim() || undefined;
}
