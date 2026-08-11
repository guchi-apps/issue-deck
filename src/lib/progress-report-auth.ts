import { timingSafeEqual } from "node:crypto";

/**
 * 進捗報告API（`POST /api/progress`）の認証（#991 Phase 2）。
 *
 * 呼ぶのはGitHub Actionsやミニ PC上のClaude Codeで、Supabaseのログインセッションを持たない。
 * CIスクリーンショット用の`CI_LOGIN_BYPASS_SECRET`（src/lib/ci-auth-bypass.ts）は本番で
 * 無効化される作りのため転用できず、専用の共有シークレットを持つ。
 *
 * 値は`PROGRESS_REPORT_SECRET`。GitHub側にはorganization secretとして置き、各リポジトリの
 * ワークフローから参照する。
 */
export type ProgressReportAuthResult = "ok" | "unauthorized" | "not_configured";

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
 * シークレット未設定は`unauthorized`ではなく`not_configured`として区別する。呼び出し側の
 * ワークフローが「設定漏れ」と「値の不一致」を切り分けられるようにするため。
 */
export function authorizeProgressReport(
  authorizationHeader: string | null,
): ProgressReportAuthResult {
  const secret = process.env.PROGRESS_REPORT_SECRET;
  if (!secret) return "not_configured";

  const prefix = "Bearer ";
  if (!authorizationHeader || !authorizationHeader.startsWith(prefix)) return "unauthorized";

  return safeEqual(authorizationHeader.slice(prefix.length), secret) ? "ok" : "unauthorized";
}
