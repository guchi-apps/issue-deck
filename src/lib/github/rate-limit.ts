const GITHUB_API = "https://api.github.com";

export type GithubRateLimit = {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

export async function fetchRateLimit(token: string): Promise<GithubRateLimit> {
  const res = await fetch(`${GITHUB_API}/rate_limit`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${GITHUB_API}/rate_limit`);
  }
  const data: { resources: { core: GithubRateLimit } } = await res.json();
  return data.resources.core;
}
