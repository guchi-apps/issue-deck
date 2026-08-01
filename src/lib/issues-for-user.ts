import { db } from "@/lib/db";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

export async function getIssuesForUser(userId: string): Promise<Issue[]> {
  const issueRows = await db.issue.findMany({
    where: { repository: { installation: { userInstallations: { some: { userId } } } } },
    include: { labels: true, repository: true },
  });

  return issueRows.map((row) => dbIssueToDisplayIssue(row.repository.fullName, row));
}
