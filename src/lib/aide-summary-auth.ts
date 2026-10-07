import { db } from "@/lib/db";
import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";
import { resolveSharedToken } from "@/lib/shared-token-reader";

/**
 * AIDE向け開発状況サマリAPI（`GET /api/integrations/aide/development-summary`。#3999）の認証。
 *
 * ログインセッションを持たないサーバー間の呼び出し（AIDEのMCP）なので`Authorization: Bearer`で受ける。
 * **専用の鍵を持ち、他のAPIの鍵を流用しない**——この鍵で読めるのは読み取り専用の集計だけで、漏洩時に
 * 止める・再発行する範囲をここに閉じるため（`image-upload-auth.ts`と同じ方針）。
 *
 * 集計の対象利用者は**呼び出し側の引数では決めない**。issue-deck側の設定（環境変数
 * `AIDE_SUMMARY_USER_LOGIN`＝GitHubログイン名）で固定し、その利用者が連携しているリポジトリだけを
 * 母集団にする。鍵は共有トークンを優先して無ければ環境変数へ倒す（#3561）が、ログイン名は認証値ではなく
 * 設定値なので共有トークンには置かない（#4048）。
 */
export async function authorizeAideSummary(
  authorizationHeader: string | null,
): Promise<SharedSecretAuthResult> {
  return authorizeBearerSecret(
    authorizationHeader,
    await resolveSharedToken("ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN", "AIDE_SUMMARY_SECRET"),
  );
}

export type AideSummaryUser = { id: string; githubLogin: string };

/** 集計の対象利用者。未設定・該当なしならnull（呼び出し側は503にする） */
export async function resolveAideSummaryUser(): Promise<AideSummaryUser | null> {
  const login = process.env.AIDE_SUMMARY_USER_LOGIN?.trim();
  if (!login) return null;
  const user = await db.user.findUnique({
    where: { githubLogin: login },
    select: { id: true, githubLogin: true },
  });
  return user;
}
