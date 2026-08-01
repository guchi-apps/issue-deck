import { db } from "@/lib/db";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

export async function getIssuesForUser(userId: string): Promise<Issue[]> {
  const issueRows = await db.issue.findMany({
    where: { repository: { installation: { userInstallations: { some: { userId } } } } },
    include: { labels: true, repository: true, favoritedBy: { where: { userId } } },
  });

  return issueRows.map((row) => ({
    ...dbIssueToDisplayIssue(row.repository, row),
    favorite: row.favoritedBy.length > 0,
  }));
}
