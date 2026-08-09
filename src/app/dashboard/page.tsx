import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import { AUTO_RETRY_LIMIT_MIN, parseClaudeModel } from "@/lib/app-settings";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getIssuesForUser } from "@/lib/issues-for-user";
import { toQuickFilter } from "@/lib/quick-filters";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  const repositories = currentUser
    ? await db.repository.findMany({
        where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
        orderBy: { fullName: "asc" },
        include: { installation: true },
      })
    : [];

  const appSetting = currentUser ? await db.appSetting.findUnique({ where: { id: 1 } }) : null;
  const autoRetryLimit = appSetting?.autoRetryLimit ?? AUTO_RETRY_LIMIT_MIN;
  const claudeModel = parseClaudeModel(appSetting?.claudeModel) ?? "auto";
  const claudeModelAssist = parseClaudeModel(appSetting?.claudeModelAssist) ?? "auto";

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

  const quickFilters = currentUser
    ? (
        await db.quickFilter.findMany({
          where: { userId: currentUser.id },
          orderBy: { createdAt: "asc" },
        })
      ).map(toQuickFilter)
    : [];

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
        hidden: hiddenRepositoryIds.has(repo.id),
        favorite: favoriteRepositoryIds.has(repo.id),
      }))}
      issues={issues}
      quickFilters={quickFilters}
      autoRetryLimit={autoRetryLimit}
      claudeModel={claudeModel}
      claudeModelAssist={claudeModelAssist}
    />
  );
}
