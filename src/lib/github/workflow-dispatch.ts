import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * ワークフローファイル名を指定して`workflow_dispatch`を起動する（#1293）。
 *
 * `release-api.ts`の`dispatchReleaseWorkflow`はリリース専用でrefも入力も固定だが、
 * こちらは自動修復のように「どのワークフローへ何を渡すか」が対象PRで変わる用途に使う。
 *
 * **起動できるのは、そのワークフローがデフォルトブランチに載っている場合だけ。**
 * GitHubは`workflow_dispatch`の受け口をデフォルトブランチのワークフロー定義から解決する
 * （このリポジトリのデフォルトブランチは`develop`）。新設したワークフローはdevelopへ
 * マージされるまで404になる。
 */
export async function dispatchWorkflow(
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
  inputs: Record<string, string>,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await githubFetch(url, token, { method: "POST", body: { ref, inputs } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(
      res.status,
      `GitHub API request failed: ${res.status} ${url} ${detail}`,
    );
  }
}
