import { NextResponse } from "next/server";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { GithubApiError } from "@/lib/github/github-api-error";
import { refreshGithubUserToken } from "@/lib/github/refresh-user-token";

type GithubUserTokenUser = {
  id: string;
  githubAccessToken: string | null;
  githubRefreshToken: string | null;
};

export type WithUserGithubTokenResult<T> = { value: T } | { errorResponse: NextResponse };

/**
 * ユーザー本人のGitHubアクセストークンを使うAPI呼び出しの共通処理（issues/route.ts・
 * issues/comments/route.tsの4箇所で重複していたロジックを共通化）。
 *
 * - トークン未保存: 409 (github_reauth_required)
 * - `fn`が401 (GithubApiError)を投げた場合: githubRefreshTokenがあれば延長を試み、成功すれば
 *   新しいトークンで`fn`を1回だけリトライする。延長・リトライのいずれかが失敗した場合は
 *   両トークンをクリアして409を返す
 * - 401以外のエラー: 502 (github_api_error)。`logContext`をconsole.errorのプレフィックスに使う
 */
export async function withUserGithubToken<T>(
  user: GithubUserTokenUser,
  logContext: string,
  fn: (token: string) => Promise<T>,
): Promise<WithUserGithubTokenResult<T>> {
  if (!user.githubAccessToken) {
    return { errorResponse: reauthRequiredResponse() };
  }

  try {
    const value = await fn(decryptSecret(user.githubAccessToken));
    return { value };
  } catch (error) {
    if (!(error instanceof GithubApiError) || error.status !== 401) {
      return { errorResponse: githubApiErrorResponse(logContext, error) };
    }
  }

  const refreshedToken = await tryRefreshToken(user);
  if (!refreshedToken) {
    await clearTokens(user.id);
    return { errorResponse: reauthRequiredResponse() };
  }

  try {
    const value = await fn(refreshedToken);
    return { value };
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await clearTokens(user.id);
      return { errorResponse: reauthRequiredResponse() };
    }
    return { errorResponse: githubApiErrorResponse(logContext, error) };
  }
}

async function tryRefreshToken(user: GithubUserTokenUser): Promise<string | null> {
  if (!user.githubRefreshToken) {
    return null;
  }

  const refreshed = await refreshGithubUserToken(decryptSecret(user.githubRefreshToken));
  if (refreshed) {
    await db.user.update({
      where: { id: user.id },
      data: {
        githubAccessToken: encryptSecret(refreshed.accessToken),
        ...(refreshed.refreshToken ? { githubRefreshToken: encryptSecret(refreshed.refreshToken) } : {}),
      },
    });
    return refreshed.accessToken;
  }

  // GitHubはrefresh_token使用のたびに新しいrefresh_tokenを払い出す（ローテーション）ため、
  // ほぼ同時の複数リクエストが同一の古いrefresh_tokenで延長を試みると片方が失敗しうる。
  // 完全な排他制御は行わず、DBの最新値を再取得し、既に別リクエストで更新済みならその
  // 新しいアクセストークンで再試行するだけの簡易的な対処に留める
  const latest = await db.user.findUnique({
    where: { id: user.id },
    select: { githubAccessToken: true },
  });
  if (latest?.githubAccessToken && latest.githubAccessToken !== user.githubAccessToken) {
    return decryptSecret(latest.githubAccessToken);
  }

  return null;
}

async function clearTokens(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { githubAccessToken: null, githubRefreshToken: null },
  });
}

function reauthRequiredResponse(): NextResponse {
  return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
}

function githubApiErrorResponse(logContext: string, error: unknown): NextResponse {
  console.error(`[${logContext}]`, error);
  return NextResponse.json(
    { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
    { status: 502 },
  );
}
