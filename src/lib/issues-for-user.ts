import { db } from "@/lib/db";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
import { getPendingDispatchAtByIssue } from "@/lib/dispatch/pending-dispatch";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

export async function getIssuesForUser(userId: string): Promise<Issue[]> {
  // 未完了ジョブ（#1347）はIssueの件数によらず1本で引ける。Issueごとに引くとN+1になる
  const [issueRows, pendingDispatchAt] = await Promise.all([
    db.issue.findMany({
      where: { repository: { installation: { userInstallations: { some: { userId } } } } },
      include: {
        labels: true,
        repository: true,
        favoritedBy: { where: { userId } },
        commentReadBy: { where: { userId } },
      },
    }),
    getPendingDispatchAtByIssue(),
  ]);

  return issueRows.map((row) => {
    const readCommentCount = row.commentReadBy[0]?.readCommentCount ?? 0;
    const dispatchedAt = pendingDispatchAt.get(
      buildDispatchActiveKey(row.repository.fullName, row.number),
    );
    return {
      ...dbIssueToDisplayIssue(row.repository, row),
      favorite: row.favoritedBy.length > 0,
      hasUnreadComments: row.commentCount > readCommentCount,
      readCommentCount,
      dispatchPendingAt: dispatchedAt?.toISOString() ?? null,
    };
  });
}
