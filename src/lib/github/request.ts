import { recordGithubApiCall } from "@/lib/github/api-usage";
import { networkErrorCode } from "@/lib/github/network-error";

export const GITHUB_API = "https://api.github.com";

type GithubFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSONとして送信する本文 */
  body?: unknown;
  /**
   * 使用量として計上するかどうか（既定はtrue）。
   * `/rate_limit`のようにレート制限を消費しないエンドポイントではfalseにする。
   * 応答を見てから計上したい場合（条件付きリクエストの304。`conditional-request.ts`）も
   * falseにして、呼び出し側で`recordGithubApiCall`を呼ぶ。
   */
  record?: boolean;
  /**
   * 追加のリクエストヘッダ。`If-None-Match`のように呼び出しごとに変わるものを渡す。
   * `Authorization`・`Accept`・`Content-Type`はここで上書きしない。
   */
  headers?: Record<string, string>;
};

/** GETの試行回数（初回を含む）。再試行の待ち時間は下の配列（ミリ秒） */
const GET_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [200, 600];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GitHub APIへのリクエストを行う共通関数。
 * 認証ヘッダの付与に加えて、用途別の使用量計測（api-usage）をここに集約する。
 * GitHub API呼び出しは必ずこの関数を経由させること（計測漏れを防ぐため）。
 *
 * **接続に失敗したGETは再試行する。** PR一覧のようにリポジトリ数ぶんのリクエストを一度に
 * 投げる画面では、同時に張る新規接続の一部が確立できずタイムアウトすることがあり
 * （WSLのローカル開発環境で再現。1リポジトリの失敗で一覧に欠けが出る）、1回投げ直すだけで
 * ほぼ回復する。**再試行するのはGETだけ**で、POST/PUT等は投げ直すとマージやコメント投稿を
 * 二重に行いかねないため対象にしない（応答が返る前の失敗でも、サーバー側では成功していることがある）。
 */
export async function githubFetch(
  url: string,
  token: string,
  options: GithubFetchOptions = {},
): Promise<Response> {
  const { method = "GET", body, record = true, headers: extraHeaders } = options;

  if (record) {
    recordGithubApiCall(url);
  }

  const maxAttempts = method === "GET" ? GET_MAX_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, {
        method,
        headers: {
          ...extraHeaders,
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const code = networkErrorCode(error);
      if (!code || attempt >= maxAttempts) throw error;
      console.warn(`[githubFetch] ${code} で失敗したため再試行します (${attempt}/${maxAttempts}): ${url}`);
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
  }
}
