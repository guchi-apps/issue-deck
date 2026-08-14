import { timingSafeEqual } from "node:crypto";

/**
 * ログインセッションを持たない呼び出し元（GitHub Actions・サブPC上のスクリプト）向けの、
 * `Authorization: Bearer <共有シークレット>` 認証の共通実装。
 *
 * 進捗報告API（`src/lib/progress-report-auth.ts`・#991 Phase 2）が先にこの形を持ち、
 * ディスパッチAPI（`src/lib/dispatch/dispatch-auth.ts`・#1179）が同じ形を必要としたため
 * ここへ切り出した。**シークレットの値そのものはこのモジュールが持たない。**
 * どの環境変数を読むかは呼び出し側が決め、ここは比較だけを引き受ける。
 *
 * 「シークレットが違う」と「シークレットを設定していない」を分けて返すのが要点で、
 * 呼び出し側のスクリプトが設定漏れと値の不一致を切り分けられるようにしている。
 */
export type SharedSecretAuthResult = "ok" | "unauthorized" | "not_configured";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // timingSafeEqualは長さが違うと例外を投げるため、先に長さで弾く（長さの漏洩は許容する）
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * `Authorization: Bearer <secret>` を検証する。
 *
 * `secret`が未設定（undefined・空文字）なら`unauthorized`ではなく`not_configured`を返す。
 */
export function authorizeBearerSecret(
  authorizationHeader: string | null,
  secret: string | undefined,
): SharedSecretAuthResult {
  if (!secret) return "not_configured";

  const prefix = "Bearer ";
  if (!authorizationHeader || !authorizationHeader.startsWith(prefix)) return "unauthorized";

  return safeEqual(authorizationHeader.slice(prefix.length), secret) ? "ok" : "unauthorized";
}
