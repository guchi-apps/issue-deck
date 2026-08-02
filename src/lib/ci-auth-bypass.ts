import { timingSafeEqual } from "node:crypto";

/**
 * CI（GitHub Actions等）の無人実行環境でPlaywright等からスクリーンショットを撮る際に、
 * Supabase Authを経由せずログイン済み状態を再現するための固定Cookie名。
 */
export const CI_BYPASS_COOKIE_NAME = "ci-login-bypass";

/**
 * バイパス対象の固定CIユーザーのsupabaseUserId。
 * scripts/ci-seed-user.mjs がこのIDでUser行をupsertする。
 */
export const CI_BYPASS_SUPABASE_USER_ID = "ci-screenshot-bot";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * 本番（NODE_ENV=production）を除外したうえで、CI_LOGIN_BYPASS_SECRET が
 * 設定されておりCookie値と一致する場合のみバイパスを有効にする。
 * どちらか一方が欠けている場合は常に無効（false）。
 */
export function isCiBypassRequest(cookieValue: string | undefined): boolean {
  if (process.env.NODE_ENV === "production") return false;

  const secret = process.env.CI_LOGIN_BYPASS_SECRET;
  if (!secret) return false;

  if (!cookieValue) return false;

  return safeEqual(cookieValue, secret);
}
