import type { ConnectedRepository } from "@/types/repository";

export const REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE =
  "このリポジトリを実行できるホストが登録されていません。実装プロンプトをコピーして手元で実行することもできます";

/** オフラインでもホストの申告は保持する。旧Actions対応フラグは実行可否に使わない。 */
export function isRepositoryAutomationUnsupported(
  repository: Pick<ConnectedRepository, "hasClaudeWorkflow" | "dispatchRunnable">,
): boolean {
  return !repository.dispatchRunnable;
}
