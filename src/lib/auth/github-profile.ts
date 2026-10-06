type GithubProfile = { id: number; login: string; name: string | null; avatar_url: string | null };

/** OAuthで取得したトークンの所有者をGitHub自身に確認する。metadataやメールで統合しない。 */
export async function fetchVerifiedGithubProfile(token: string | null | undefined): Promise<GithubProfile> {
  if (!token) throw new Error("missing_provider_token");
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("github_identity_unavailable");
  const profile = await response.json();
  if (!profile || !Number.isSafeInteger(profile.id) || profile.id <= 0
    || typeof profile.login !== "string" || !profile.login.trim()) {
    throw new Error("invalid_github_identity");
  }
  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === "string" ? profile.name : null,
    avatar_url: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
  };
}
