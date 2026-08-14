import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * 進捗報告API（`POST /api/progress`）の認証（#991 Phase 2）。
 *
 * 呼ぶのはGitHub Actionsやミニ PC上のClaude Codeで、Supabaseのログインセッションを持たない。
 * CIスクリーンショット用の`CI_LOGIN_BYPASS_SECRET`（src/lib/ci-auth-bypass.ts）は本番で
 * 無効化される作りのため転用できず、専用の共有シークレットを持つ。
 *
 * 値は`PROGRESS_REPORT_SECRET`。GitHub側にはorganization secretとして置き、各リポジトリの
 * ワークフローから参照する。
 *
 * **ディスパッチAPI（#1179）はこの値を流用せず、別の`DISPATCH_SECRET`を持つ**
 * （src/lib/dispatch/dispatch-auth.ts）。こちらは全リポジトリのActionsから参照できる値で、
 * 「サブPCでジョブを取れる」権限まで同じ値に載せると権限の粒度が分けられなくなるため。
 * Bearer検証の実装自体は`src/lib/shared-secret-auth.ts`で共有している。
 */
export type ProgressReportAuthResult = SharedSecretAuthResult;

/**
 * `Authorization: Bearer <secret>` を検証する。
 *
 * シークレット未設定は`unauthorized`ではなく`not_configured`として区別する。呼び出し側の
 * ワークフローが「設定漏れ」と「値の不一致」を切り分けられるようにするため。
 */
export function authorizeProgressReport(
  authorizationHeader: string | null,
): ProgressReportAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.PROGRESS_REPORT_SECRET);
}
