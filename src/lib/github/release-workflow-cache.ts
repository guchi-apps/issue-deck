import { fetchReleaseWorkflowExists } from "@/lib/github/release-api";

/**
 * `release-develop-to-main.yml`の有無はほとんど変化しないため、ポーリングのたびに問い合わせず
 * プロセス内にキャッシュしてGitHub APIの消費を抑える。
 * 本番はPM2のfork（単一プロセス）で動作し、プロセスが入れ替わればキャッシュは空になる。
 * `/api/repositories/release`と`/api/repositories/release-pending-merges`の両方で共有する。
 */
const RELEASE_WORKFLOW_EXISTS_TTL_MS = 10 * 60_000;
const releaseWorkflowExistsCache = new Map<string, { exists: boolean; cachedAt: number }>();

export async function releaseWorkflowExists(owner: string, repo: string, token: string): Promise<boolean> {
  const key = `${owner}/${repo}`;
  const cached = releaseWorkflowExistsCache.get(key);
  if (cached && Date.now() - cached.cachedAt < RELEASE_WORKFLOW_EXISTS_TTL_MS) {
    return cached.exists;
  }
  const exists = await fetchReleaseWorkflowExists(owner, repo, token);
  releaseWorkflowExistsCache.set(key, { exists, cachedAt: Date.now() });
  return exists;
}
