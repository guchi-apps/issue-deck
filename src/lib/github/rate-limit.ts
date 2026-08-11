import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type GithubRateLimit = {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

/**
 * 画面に出すレート制限の枠。
 *
 * **GitHubはRESTとGraphQLで別々のレート制限を持つ。** Projects v2はGraphQL専用API
 * （RESTが存在しない）のため、進捗Statusの読み書き・盤面への追加はすべてGraphQL枠を消費する
 * （#991 Phase 2〜4）。coreだけを見ていると、そちらの消費が画面に一切現れない（#1040）。
 */
export const RATE_LIMIT_RESOURCES = [
  { key: "core", label: "REST" },
  { key: "graphql", label: "GraphQL" },
] as const;

export type RateLimitResourceKey = (typeof RATE_LIMIT_RESOURCES)[number]["key"];

export type GithubRateLimitResource = GithubRateLimit & {
  key: RateLimitResourceKey;
  label: string;
};

type RateLimitResponse = { resources: Partial<Record<RateLimitResourceKey, GithubRateLimit>> };

/**
 * インストールのレート制限を枠ごとに取得する。
 *
 * `/rate_limit`自体はレート制限を消費しないため、使用量には計上しない。
 * 応答に含まれない枠（GitHub側の仕様変更・トークン種別による差）は黙って除外する。
 */
export async function fetchRateLimit(token: string): Promise<GithubRateLimitResource[]> {
  const res = await githubFetch(`${GITHUB_API}/rate_limit`, token, { record: false });
  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${GITHUB_API}/rate_limit`);
  }
  const data: RateLimitResponse = await res.json();

  return RATE_LIMIT_RESOURCES.flatMap(({ key, label }) => {
    const resource = data.resources[key];
    return resource ? [{ key, label, ...resource }] : [];
  });
}
