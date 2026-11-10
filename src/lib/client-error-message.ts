/**
 * ブラウザの`fetch`は、応答が返る前に通信が切れると`TypeError`を投げる。文言はブラウザごとに違い、
 * Safariは`Load failed`、Chromeは`Failed to fetch`、Firefoxは`NetworkError when attempting to fetch resource.`
 * になる。そのまま画面へ出すと何が起きたか伝わらないため、日本語の文へ置き換える。
 */
export const NETWORK_FAILURE_MESSAGE = "通信に失敗しました。接続を確認して、もう一度お試しください。";

const NETWORK_FAILURE_PATTERN = /^(load failed|failed to fetch|networkerror when attempting to fetch resource\.?|network request failed|the network connection was lost\.?)$/i;

/** ブラウザの`fetch`が通信失敗で投げた例外かどうか。 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FAILURE_PATTERN.test(error.message.trim());
}

/** 画面に出すエラー文言。通信失敗は日本語の定型文にし、それ以外は元のメッセージのまま返す。 */
export function clientErrorMessage(error: unknown): string {
  if (isNetworkFailure(error)) return NETWORK_FAILURE_MESSAGE;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 通信失敗のときだけ1回再取得する`fetch`。**読み取り（GET）専用**で、書き込みには使わない
 * （応答が返らなかっただけでサーバー側は実行済みの可能性があるため）。
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retryDelayMs = 500,
): Promise<Response> {
  try {
    return await (init ? fetch(input, init) : fetch(input));
  } catch (error) {
    if (!isNetworkFailure(error) || init?.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return init ? fetch(input, init) : fetch(input);
  }
}
