import { IssueDeckShell } from "@/components/dashboard/issue-deck-shell";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";

export default async function DashboardPage() {
  const currentUser = await getCurrentUser();

  const repositories = currentUser
    ? await db.repository.findMany({
        where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
        orderBy: { fullName: "asc" },
        include: { installation: true },
      })
    : [];

  const issueRows = currentUser
    ? await db.issue.findMany({
        where: { repository: { installation: { userInstallations: { some: { userId: currentUser.id } } } } },
        include: { labels: true, repository: true },
      })
    : [];

  const issues = issueRows.map((row) => dbIssueToDisplayIssue(row.repository.fullName, row));

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
    />
  );
}
