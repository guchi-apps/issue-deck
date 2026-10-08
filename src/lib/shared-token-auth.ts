import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * アプリ間共有トークンAPI用のBearer認証。ディスパッチ等の既存共有シークレットと
 * 権限を混ぜず、共有トークンを読む呼び出し元だけへ渡す値を使う。
 */
export function authorizeSharedTokenApi(
  authorizationHeader: string | null,
): SharedSecretAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.SHARED_TOKEN_API_SECRET);
}

/** 保護された名前への書き込み専用。読み取りキーとの共用は設定不備として拒否する。 */
export function authorizeProtectedSharedTokenWrite(header: string | null): SharedSecretAuthResult {
  const secret = process.env.SHARED_TOKEN_WRITE_SECRET;
  if (!secret || secret === process.env.SHARED_TOKEN_API_SECRET) return "not_configured";
  return authorizeBearerSecret(header, secret);
}
