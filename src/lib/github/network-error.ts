/**
 * 応答が返る前に落ちた一時的な通信エラーのコード。TCP接続の確立に失敗した・途中で切れた
 * 類のもので、同じリクエストをもう一度投げれば通る見込みがあるものだけを並べている。
 * HTTPステータスで返るエラー（403のレート制限など）はここでは扱わない。
 */
const NETWORK_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/**
 * 通信エラーならそのコードを返す。Node（undici）のfetchは接続失敗を
 * `TypeError: fetch failed`で包み、実際の原因を`cause`に入れるため、そこから取り出す。
 */
export function networkErrorCode(error: unknown): string | null {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code) ? code : null;
}

/**
 * GitHub API呼び出しの例外を画面に出せる文言にする。通信エラーの`fetch failed`は
 * そのまま出しても何が起きたか伝わらないため、状況と次の行動が分かる文へ置き換える。
 */
export function githubApiErrorMessage(error: unknown): string {
  if (networkErrorCode(error)) {
    return "GitHubへの接続に失敗しました。時間をおいて再度お試しください。";
  }
  return error instanceof Error ? error.message : String(error);
}
