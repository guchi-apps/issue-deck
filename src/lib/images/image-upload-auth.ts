import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * 画像アップロードAPI（`POST /api/issues/images`）のBearer認証（#3507）。
 *
 * 呼ぶのはAIDEのMCPツール（`issue_deck_upload_image`）で、ログインセッションを持たない
 * サーバー間の呼び出し。ログインCookieの認証は従来どおり残し、Authorizationヘッダが付いたときだけ
 * この値で検証する。
 *
 * **`PROGRESS_REPORT_SECRET`・`DISPATCH_SECRET`を流用せず、専用の`IMAGE_UPLOAD_SECRET`を持つ**
 * （`src/lib/dispatch/dispatch-auth.ts`と同じ方針）。この値で書けるのはアップロードだけなので、
 * 漏洩時に止める・再発行する範囲をここに閉じられる。未設定なら`not_configured`（503）。
 */
export function authorizeImageUpload(authorizationHeader: string | null): SharedSecretAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.IMAGE_UPLOAD_SECRET);
}
