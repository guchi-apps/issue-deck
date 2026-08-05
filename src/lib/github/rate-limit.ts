import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type GithubRateLimit = {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

export async function fetchRateLimit(token: string): Promise<GithubRateLimit> {
  // `/rate_limit`自体はレート制限を消費しないため、使用量には計上しない。
  const res = await githubFetch(`${GITHUB_API}/rate_limit`, token, { record: false });
  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${GITHUB_API}/rate_limit`);
  }
  const data: { resources: { core: GithubRateLimit } } = await res.json();
  return data.resources.core;
}
