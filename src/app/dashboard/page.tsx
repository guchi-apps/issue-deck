import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import {
  AUTO_RETRY_LIMIT_MIN,
  APP_AI_MODEL_DEFAULT,
  APP_AI_MODEL_REASONING_DEFAULT,
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CODEX_MODEL_DEFAULT,
  DISPATCH_CONCURRENCY_DEFAULT,
  parseClaudeModel,
  parseCodexModel,
  parseAppAiModel,
} from "@/lib/app-settings";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listDispatchRunnableRepositories } from "@/lib/dispatch/runnable-repositories";
import { getIssuesForUser } from "@/lib/issues-for-user";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  const repositories = currentUser
    ? await db.repository.findMany({
        where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
        orderBy: { fullName: "asc" },
        include: { installation: true },
      })
    : [];

  const appSetting = (currentUser
    ? await db.appSetting.findUnique({ where: { id: 1 } })
    : null) as
    | ({ claudeLocalModel?: string } & Awaited<ReturnType<typeof db.appSetting.findUnique>>)
    | null;
  const autoRetryLimit = appSetting?.autoRetryLimit ?? AUTO_RETRY_LIMIT_MIN;
  const claudeModel = parseClaudeModel(appSetting?.claudeModel) ?? "auto";
  const claudeModelAssist = parseClaudeModel(appSetting?.claudeModelAssist) ?? "auto";
  const claudeLocalModel =
    parseClaudeModel(appSetting?.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT;
  const codexModel = parseCodexModel(appSetting?.codexModel) ?? CODEX_MODEL_DEFAULT;
  const appAiModel = parseAppAiModel(appSetting?.appAiModel) ?? APP_AI_MODEL_DEFAULT;
  const appAiModelReasoning =
    parseAppAiModel(appSetting?.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT;
  const dispatchConcurrency = appSetting?.dispatchConcurrency ?? DISPATCH_CONCURRENCY_DEFAULT;

  const hiddenRepositoryIds = currentUser
    ? new Set(
        (
          await db.hiddenRepository.findMany({
            where: { userId: currentUser.id },
            select: { repositoryId: true },
          })
        ).map((row) => row.repositoryId),
      )
    : new Set<string>();

  const favoriteRepositoryIds = currentUser
    ? new Set(
        (
          await db.favoriteRepository.findMany({
            where: { userId: currentUser.id },
            select: { repositoryId: true },
          })
        ).map((row) => row.repositoryId),
      )
    : new Set<string>();

  const issues = currentUser ? await getIssuesForUser(currentUser.id) : [];

  // 一覧の「どちらの実行経路にも対応していない」印（#1888）に使う。無人実行の有無
  // （`hasClaudeWorkflow`）だけでは、サブPCのローカルセッションでのみ回すリポジトリ（#1741）に
  // 非対応の印が出てしまう
  const dispatchRunnableRepositories = currentUser
    ? await listDispatchRunnableRepositories()
    : new Set<string>();

  return (
    <IssueDeckShell
      currentUser={
        currentUser
          ? { login: currentUser.githubLogin, name: currentUser.name, image: currentUser.image }
          : null
      }
      repositories={repositories.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        private: repo.private,
        archived: repo.archived,
        hasClaudeWorkflow: repo.hasClaudeWorkflow,
        hasLocalStartScript: repo.hasLocalStartScript,
        dispatchRunnable: dispatchRunnableRepositories.has(repo.fullName),
        hidden: hiddenRepositoryIds.has(repo.id),
        favorite: favoriteRepositoryIds.has(repo.id),
      }))}
      issues={issues}
      /* 一覧のヘッダーに出す「HH:MM時点」の初期値（#1797）。クライアント側で現在時刻を
         作るとハイドレーションが崩れるため、描いた時刻はここで確定させて渡す */
      issuesFetchedAt={new Date().toISOString()}
      autoRetryLimit={autoRetryLimit}
      claudeModel={claudeModel}
      claudeModelAssist={claudeModelAssist}
      claudeLocalModel={claudeLocalModel}
      codexModel={codexModel}
      appAiModel={appAiModel}
      appAiModelReasoning={appAiModelReasoning}
      dispatchConcurrency={dispatchConcurrency}
    />
  );
}
