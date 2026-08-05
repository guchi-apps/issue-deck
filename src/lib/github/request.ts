import { recordGithubApiCall } from "@/lib/github/api-usage";

export const GITHUB_API = "https://api.github.com";

type GithubFetchOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** JSONとして送信する本文 */
  body?: unknown;
  /**
   * 使用量として計上するかどうか（既定はtrue）。
   * `/rate_limit`のようにレート制限を消費しないエンドポイントではfalseにする。
   */
  record?: boolean;
};

/**
 * GitHub APIへのリクエストを行う共通関数。
 * 認証ヘッダの付与に加えて、用途別の使用量計測（api-usage）をここに集約する。
 * GitHub API呼び出しは必ずこの関数を経由させること（計測漏れを防ぐため）。
 */
export async function githubFetch(
  url: string,
  token: string,
  options: GithubFetchOptions = {},
): Promise<Response> {
  const { method = "GET", body, record = true } = options;

  if (record) {
    recordGithubApiCall(url);
  }

  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
