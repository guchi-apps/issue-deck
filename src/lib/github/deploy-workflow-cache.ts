import { DEPLOY_WORKFLOW_FILE } from "@/lib/github/release-api";
import { workflowExists } from "@/lib/github/workflow-exists-cache";

/**
 * リポジトリが本番デプロイworkflow（`deploy.yml`）を持つか（#2020）。
 *
 * 「本番へ再デプロイ」を出してよいかの前提で、判定は起動側（`/api/repositories/deploy`）と
 * ブランチ画面（`/api/branch-flow`）が共有する。キャッシュ本体は`workflow-exists-cache.ts`。
 *
 * **持っていても`workflow_dispatch`を書いていないリポジトリがある**（`guchi-apps/portfolio`）ので、
 * これだけでは起動できると言い切れない。そちらはdispatchが422で落ちた時点で専用の文言へ振り分ける。
 * ファイルの有無しか分からないのは、GitHubのworkflow APIが起動条件を返さないため。
 */
export function deployWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  return workflowExists(owner, repo, DEPLOY_WORKFLOW_FILE, token);
}
