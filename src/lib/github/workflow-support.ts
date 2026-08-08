import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * issue-deckのマルチエージェント運用の起点となる中核workflowのファイル名。
 * このファイルの存在有無を「issue-deckの自動化が最低限動く状態かどうか」の近似指標として使う（#720）。
 * 完全な対応可否判定ではない（ラベル体系・CLAUDE.md・Secretsなど他の要素は考慮していない）。
 */
export const CLAUDE_WORKFLOW_FILE = "claude-issue-dispatch.yml";

/** リポジトリに`claude-issue-dispatch.yml`と同名のworkflowが存在するかどうか */
export async function fetchClaudeWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${CLAUDE_WORKFLOW_FILE}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return true;
}
