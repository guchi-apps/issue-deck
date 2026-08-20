import { db } from "@/lib/db";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
import { getPendingDispatchAtByIssue } from "@/lib/dispatch/pending-dispatch";
import { listManualStepVerifiedAtByIssue } from "@/lib/manual-step-verification-patrol";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

export async function getIssuesForUser(userId: string): Promise<Issue[]> {
  // 未完了ジョブ（#1347）はIssueの件数によらず1本で引ける。Issueごとに引くとN+1になる
  const [issueRows, pendingDispatchAt, manualStepVerifiedAt] = await Promise.all([
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
    // 完了確認の巡回の結果（#2008）も1本で引く。Issueごとに引くと順番待ちと同じくN+1になる
    listManualStepVerifiedAtByIssue(),
  ]);

  return issueRows.map((row) => {
    const readCommentCount = row.commentReadBy[0]?.readCommentCount ?? 0;
    const activeKey = buildDispatchActiveKey(row.repository.fullName, row.number);
    const dispatchedAt = pendingDispatchAt.get(activeKey);
    const verifiedAt = manualStepVerifiedAt.get(activeKey);
    return {
      ...dbIssueToDisplayIssue(row.repository, row),
      favorite: row.favoritedBy.length > 0,
      hasUnreadComments: row.commentCount > readCommentCount,
      readCommentCount,
      dispatchPendingAt: dispatchedAt?.toISOString() ?? null,
      manualStepVerifiedAt: verifiedAt?.toISOString() ?? null,
    };
  });
}
