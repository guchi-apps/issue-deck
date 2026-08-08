const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

export type RefreshedGithubUserToken = {
  accessToken: string;
  refreshToken?: string;
};

type GithubOauthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

/**
 * refresh_token grantでユーザー本人のGitHubアクセストークンの延長を試みる。
 * `GITHUB_OAUTH_CLIENT_ID`・`GITHUB_OAUTH_CLIENT_SECRET`（Supabase AuthのGitHubプロバイダー設定と
 * 同一の値が必要）が未設定の場合や、GitHub側がエラーを返した場合はnullを返す。呼び出し側は
 * nullの場合、現状どおりの再ログイン導線にフォールバックすること。
 */
export async function refreshGithubUserToken(
  refreshToken: string,
): Promise<RefreshedGithubUserToken | null> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }

  let res: Response;
  try {
    res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch (error) {
    console.error("[refreshGithubUserToken] request failed", error);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[refreshGithubUserToken] GitHub returned ${res.status}: ${detail}`);
    return null;
  }

  // GitHubのOAuthトークンエンドポイントは、無効なrefresh_token等のエラー時もHTTP 200で
  // `error`フィールドを含むJSONを返すことがあるため、ステータスコードだけでは判定できない
  const data: GithubOauthTokenResponse = await res.json().catch(() => ({}));
  if (!data.access_token || data.error) {
    console.error(
      `[refreshGithubUserToken] GitHub response missing access_token: ${data.error ?? "unknown"} ${data.error_description ?? ""}`,
    );
    return null;
  }

  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}
