import { db } from "@/lib/db";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
import { getPendingDispatchAt, getPendingDispatchAtByIssue } from "@/lib/dispatch/pending-dispatch";
import { listManualStepVerifiedAtByIssue } from "@/lib/manual-step-verification-patrol";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import { getParentRunChildMarksByIssue, toParentRunChildMark } from "@/lib/parent-run/child-state-query";
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
  const where = { repository: { installation: { userInstallations: { some: { userId } } } } };
  const [issueRows, openBodies, pendingDispatchAt, manualStepVerifiedAt, parentRunChildMarks] = await Promise.all([
    db.issue.findMany({
      where,
      // 並びを固定する。`GET /api/issues`は一覧のハッシュをETagにしており（#3387）、
      // 内容が同じでも並びが揺れると304にならず、毎回まるごと送り直すことになる
      orderBy: { id: "asc" },
      // 本文はDBから読まない（#4255）。読んでから捨てると、閉じたIssueの本文が一覧の取得のたびに
      // 全件ぶんヒープへ載る。openの本文だけを下の別クエリで引いて合流する
      omit: { body: true },
      include: {
        labels: { orderBy: { id: "asc" } },
        repository: true,
        commentReadBy: { where: { userId } },
      },
    }),
    options.bodies === "open"
      ? db.issue
          .findMany({ where: { ...where, state: "OPEN" }, select: { id: true, body: true } })
          .then((rows) => new Map(rows.map((r) => [r.id, r.body])))
      : Promise.resolve(new Map<string, string | null>()),
    getPendingDispatchAtByIssue(),
    // 完了確認の巡回の結果（#2008）も1本で引く。Issueごとに引くと順番待ちと同じくN+1になる
    listManualStepVerifiedAtByIssue(),
    // 親の自動実行の対象の子（#4953）も1本で引く
    getParentRunChildMarksByIssue(),
  ]);

  return issueRows.map((row) => {
    const readCommentCount = row.commentReadBy[0]?.readCommentCount ?? 0;
    const activeKey = buildDispatchActiveKey(row.repository.fullName, row.number);
    const parentRunChild = parentRunChildMarks.get(`${row.repository.fullName}#${row.number}`);
    // 親の実行で起動済みの子は、Statusが`Ready`のままでも「実行中」へ振り分ける（#4953）
    const dispatchedAt =
      pendingDispatchAt.get(activeKey) ?? (parentRunChild?.kind === "running" ? new Date(parentRunChild.at) : undefined);
    const verifiedAt = manualStepVerifiedAt.get(activeKey);
    const issue: Issue = {
      ...dbIssueToDisplayIssue(row.repository, { ...row, body: openBodies.get(row.id) ?? null }),
      hasUnreadComments: row.commentCount > readCommentCount,
      readCommentCount,
      dispatchPendingAt: dispatchedAt?.toISOString() ?? null,
      parentRunChild: toParentRunChildMark(parentRunChild),
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

/**
 * 1件ぶんの取得（#4396）。権限は一覧と同じ「ユーザーが見えるインストールのリポジトリ」。
 * 一覧を丸ごと作らずに、起動の導線が対象のIssueだけを読めるようにする
 */
export async function getIssueForUser(
  userId: string,
  repositoryFullName: string,
  number: number,
): Promise<Issue | null> {
  const row = await db.issue.findFirst({
    where: {
      number,
      repository: { fullName: repositoryFullName, installation: { userInstallations: { some: { userId } } } },
    },
    include: {
      labels: { orderBy: { id: "asc" } },
      repository: true,
      commentReadBy: { where: { userId } },
    },
  });
  if (!row) return null;
  const readCommentCount = row.commentReadBy[0]?.readCommentCount ?? 0;
  const parentRunChild = (await getParentRunChildMarksByIssue()).get(`${row.repository.fullName}#${row.number}`);
  const dispatchedAt =
    (await getPendingDispatchAt(buildDispatchActiveKey(row.repository.fullName, row.number))) ??
    (parentRunChild?.kind === "running" ? new Date(parentRunChild.at) : null);
  return {
    ...dbIssueToDisplayIssue(row.repository, row),
    hasUnreadComments: row.commentCount > readCommentCount,
    readCommentCount,
    dispatchPendingAt: dispatchedAt?.toISOString() ?? null,
    parentRunChild: toParentRunChildMark(parentRunChild),
    manualStepVerifiedAt: null,
  };
}
