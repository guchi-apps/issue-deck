import { RELEASE_WORKFLOW_FILE } from "@/lib/github/release-api";
import { workflowExists } from "@/lib/github/workflow-exists-cache";

/**
 * `release-develop-to-main.yml`の有無はほとんど変化しないため、ポーリングのたびに問い合わせず
 * プロセス内にキャッシュしてGitHub APIの消費を抑える。
 * `/api/repositories/release`と`/api/repositories/release-pending-merges`の両方で共有する。
 *
 * キャッシュそのものは`workflow-exists-cache.ts`が持つ（#2020）。同じ判定を本番デプロイ
 * （`deploy.yml`）・自動修復ワークフローも行うため、TTLと実行中リクエストの共有を1か所に寄せた。
 */
export function releaseWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  return workflowExists(owner, repo, RELEASE_WORKFLOW_FILE, token);
}
