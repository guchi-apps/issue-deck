import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import {
  AUTO_RETRY_LIMIT_MIN,
  APP_AI_MODEL_DEFAULT,
  APP_AI_MODEL_REASONING_DEFAULT,
  MODEL_PICK_ENGINE_DEFAULT,
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CODEX_MODEL_DEFAULT,
  DISPATCH_CONCURRENCY_DEFAULT,
  parseClaudeLocalModelSetting,
  parseClaudeModel,
  parseCodexModelSetting,
  parseAppAiModel,
  parseModelPickEngine,
} from "@/lib/app-settings";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listDispatchRunnableRepositories } from "@/lib/dispatch/runnable-repositories";
import { getIssuesForUser } from "@/lib/issues-for-user";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  // 初期表示の読み出しは互いに依存しないので並べて待つ（#3387）。以前は8本を1本ずつ
  // 直列に待っており、DBの往復ぶんだけ最初の表示が遅れていた
  const [
    repositories,
    appSettingRow,
    hiddenRepositoryRows,
    favoriteRepositoryRows,
    issueCreationExcludedRepositoryRows,
    releaseCheckTargetRows,
    issues,
    dispatchRunnableRepositories,
  ] = currentUser
    ? await Promise.all([
        db.repository.findMany({
          where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
          orderBy: { fullName: "asc" },
          include: { installation: true },
        }),
        db.appSetting.findUnique({ where: { id: 1 } }),
        db.hiddenRepository.findMany({
          where: { userId: currentUser.id },
          select: { repositoryId: true },
        }),
        db.favoriteRepository.findMany({
          where: { userId: currentUser.id },
          select: { repositoryId: true },
        }),
        db.issueCreationExcludedRepository.findMany({
          where: { userId: currentUser.id },
          select: { repositoryId: true },
        }),
        // リリース後の動作確認の対象リポジトリ（#2930）。**他の3つと同じくここで読む**——
        // リリース履歴APIの応答へ相乗りさせると、対象の選択欄が「全リポジトリぶんのGitHub APIを
        // 叩く重い取得」が返るまで全部オフに見える。値は真偽ではなく**いつから対象か**で、
        // これより前に公開されたリリースには未確認を立てない（`lib/release-check.ts`）。
        db.releaseCheckTarget.findMany({
          where: { userId: currentUser.id },
          select: { repositoryId: true, createdAt: true },
        }),
        getIssuesForUser(currentUser.id),
        // 一覧の「どちらの実行経路にも対応していない」印（#1888）に使う。無人実行の有無
        // （`hasClaudeWorkflow`）だけでは、サブPCのローカルセッションでのみ回すリポジトリ（#1741）に
        // 非対応の印が出てしまう
        listDispatchRunnableRepositories(),
      ])
    : [[], null, [], [], [], [], [], new Set<string>()];

  const appSetting = appSettingRow as
    | ({ claudeLocalModel?: string } & Awaited<ReturnType<typeof db.appSetting.findUnique>>)
    | null;
  const autoRetryLimit = appSetting?.autoRetryLimit ?? AUTO_RETRY_LIMIT_MIN;
  const claudeModel = parseClaudeModel(appSetting?.claudeModel) ?? "auto";
  const claudeModelAssist = parseClaudeModel(appSetting?.claudeModelAssist) ?? "auto";
  // `claudeLocalModel`は#2776で`auto`を選べなくした。既存値が`auto`のまま残っていても
  // `parseClaudeLocalModelSetting`が弾いて既定（sonnet）へ倒す（`parseClaudeModel`だと`auto`を
  // 通してしまい、選べないはずの値がshellのstateへ入ってしまう）。#3106で「おまかせ」（`pick`）は通す
  const claudeLocalModel =
    parseClaudeLocalModelSetting(appSetting?.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT;
  const codexModel = parseCodexModelSetting(appSetting?.codexModel) ?? CODEX_MODEL_DEFAULT;
  const appAiModel = parseAppAiModel(appSetting?.appAiModel) ?? APP_AI_MODEL_DEFAULT;
  const appAiModelReasoning =
    parseAppAiModel(appSetting?.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT;
  const modelPickEngine =
    parseModelPickEngine(appSetting?.modelPickEngine) ?? MODEL_PICK_ENGINE_DEFAULT;
  const dispatchConcurrency = appSetting?.dispatchConcurrency ?? DISPATCH_CONCURRENCY_DEFAULT;

  const hiddenRepositoryIds = new Set(hiddenRepositoryRows.map((row) => row.repositoryId));
  const favoriteRepositoryIds = new Set(favoriteRepositoryRows.map((row) => row.repositoryId));
  const issueCreationExcludedRepositoryIds = new Set(
    issueCreationExcludedRepositoryRows.map((row) => row.repositoryId),
  );
  const releaseCheckSinceByRepositoryId = new Map(
    releaseCheckTargetRows.map((row) => [row.repositoryId, row.createdAt.toISOString()]),
  );

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
        excludedFromIssueCreation: issueCreationExcludedRepositoryIds.has(repo.id),
        releaseCheckSince: releaseCheckSinceByRepositoryId.get(repo.id) ?? null,
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
      modelPickEngine={modelPickEngine}
      dispatchConcurrency={dispatchConcurrency}
    />
  );
}
