/**
 * リリースworkflowの起動リクエスト（#1510）。
 *
 * 起動の導線は2か所ある——ヘッダーのロケットボタン（`release-status-button.tsx`）と、
 * 「ブランチとPRの流れ」画面の「リリースする」（`repository-release-button.tsx`）。
 * **叩くエンドポイントもエラーの読み方も1か所に置く**ことで、どちらから押しても同じ結果に
 * なることを保つ。流れ画面のボタンは状態取得（`useReleaseStatus`）を必要としないため、
 * ポーリングを持つフックごと持ち込まずにこの関数だけを使う。
 */

/** エラーコードを画面に出す文言へ直す。`useReleaseStatus`の取得側と同じ文面に揃えている */
export function releaseErrorMessage(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/**
 * `POST /api/repositories/release`。成功すれば何も返さず、失敗すれば
 * {@link releaseErrorMessage} の文言を持つ`Error`を投げる。
 */
export async function requestRelease(repoFullName: string): Promise<void> {
  const [owner, repo] = repoFullName.split("/");

  const res = await fetch("/api/repositories/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo }),
  });
  const json: { error?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(releaseErrorMessage(res.status, json.error, json.message));
}
