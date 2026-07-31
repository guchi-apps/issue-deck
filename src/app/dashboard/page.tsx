import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchDashboardIssues } from "@/lib/github/fetch-dashboard-issues";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  const repositories = currentUser
    ? await db.repository.findMany({
        where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
        orderBy: { fullName: "asc" },
        include: { installation: true },
      })
    : [];

  const { issues, errors } =
    repositories.length > 0
      ? await fetchDashboardIssues(repositories)
      : { issues: [], errors: [] };

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
      }))}
      issues={issues}
      fetchErrors={errors}
    />
  );
}
