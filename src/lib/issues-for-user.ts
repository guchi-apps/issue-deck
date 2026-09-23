import { db } from "@/lib/db";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
import { getPendingDispatchAtByIssue } from "@/lib/dispatch/pending-dispatch";
import { listManualStepVerifiedAtByIssue } from "@/lib/manual-step-verification-patrol";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

/**
 * 一覧に載せる本文の範囲（#3390）。
 *
 * - `open`: openのIssueだけ本文を持たせ、closedは外す（`bodyOmitted`）。デッキ本体
 *   （`/dashboard`・`GET /api/issues`）が使う。前提条件の待ち（`manual-step-prerequisites.ts`）・
 *   手作業の案内・一覧の検索はopenの本文を一覧から直接読むので、openまでは外さない
 * - `none`: 全件の本文を外す。`/issues/new`は`#123`補完に番号とタイトルしか使わない
 */
export type IssueListBodies = "open" | "none";

export async function getIssuesForUser(
  userId: string,
  options: { bodies: IssueListBodies } = { bodies: "open" },
): Promise<Issue[]> {
  // 未完了ジョブ（#1347）はIssueの件数によらず1本で引ける。Issueごとに引くとN+1になる
  const [issueRows, pendingDispatchAt, manualStepVerifiedAt] = await Promise.all([
    db.issue.findMany({
      where: { repository: { installation: { userInstallations: { some: { userId } } } } },
      // 並びを固定する。`GET /api/issues`は一覧のハッシュをETagにしており（#3387）、
      // 内容が同じでも並びが揺れると304にならず、毎回まるごと送り直すことになる
      orderBy: { id: "asc" },
      include: {
        labels: { orderBy: { id: "asc" } },
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
    const issue: Issue = {
      ...dbIssueToDisplayIssue(row.repository, row),
      favorite: row.favoritedBy.length > 0,
      hasUnreadComments: row.commentCount > readCommentCount,
      readCommentCount,
      dispatchPendingAt: dispatchedAt?.toISOString() ?? null,
      manualStepVerifiedAt: verifiedAt?.toISOString() ?? null,
    };
    return shouldOmitBody(issue, options.bodies) ? omitIssueBody(issue) : issue;
  });
}

function shouldOmitBody(issue: Issue, bodies: IssueListBodies): boolean {
  return bodies === "none" || issue.state === "closed";
}

/** 本文を外した形にする（#3390）。空文字にしたうえで印を立て、「本文が無い」と区別する */
export function omitIssueBody(issue: Issue): Issue {
  return { ...issue, body: "", bodyOmitted: true };
}
