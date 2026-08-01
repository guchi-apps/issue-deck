import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
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

  const issues = currentUser ? await getIssuesForUser(currentUser.id) : [];

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
        hidden: hiddenRepositoryIds.has(repo.id),
      }))}
      issues={issues}
    />
  );
}
