import { db } from "@/lib/db";
import {
  CHECK_USER_LABEL,
  checkUserReason,
  type CheckUserReason,
} from "@/lib/github/approval-labels";

/**
 * PRの対応Issueに`00.check-user`が付いているかを、IssueのDBキャッシュから引く（#1469）。
 *
 * develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定させる
 * ワークフローは、その結論を**PRではなく対応Issueの`00.check-user`**として書く
 * （`reusable-claude-review-develop.yml`の`auto-merge`と、判定経路を持たないリポジトリ向けの
 * 保険である`reusable-issue-labels.yml`の`develop-pr-opened`。#1470）。PR一覧・PR詳細は
 * GitHub APIからPRを取るだけでこのラベルを知れないため、ここでIssueのキャッシュと合流させる。
 *
 * **GitHub APIは消費しない。** 一覧は全リポジトリぶんをまとめて1クエリで引く。
 *
 * このファイルはPrismaに触れるためクライアントコンポーネントからimportできない。表示の判定に
 * 使う純粋関数（`requiresUserMerge`）は`src/lib/pull-request-list.ts`側にある。
 */
export type CheckUserIssueTarget = {
  repositoryId: string;
  /** そのリポジトリで調べたい対応Issue番号。重複していても構わない */
  issueNumbers: number[];
};

/** `fetchCheckUserIssueReasons`が返すMapのキー。リポジトリを跨いで番号が衝突しないようにする */
export function checkUserIssueKey(repositoryId: string, issueNumber: number): string {
  return `${repositoryId}#${issueNumber}`;
}

/**
 * `00.check-user`が付いているIssueについて、{@link checkUserIssueKey} → 理由（#1490）のMapを返す。
 * **Mapに載っていること自体が`00.check-user`が付いていること**を表し、値は理由ラベル
 * （`01.check-*`）が読めなければ`null`になる。
 *
 * 番号だけの`in`で引くとリポジトリを跨いで同じ番号のIssueを拾ってしまうため、
 * リポジトリごとの`OR`で引き、返ってきた行の`(repositoryId, number)`の組で突き合わせる。
 *
 * 理由を読むためにラベル名も引くが、**クエリの本数は増えない**（同じ1クエリのincludeが増えるだけ）。
 */
export async function fetchCheckUserIssueReasons(
  targets: CheckUserIssueTarget[],
): Promise<Map<string, CheckUserReason | null>> {
  const conditions = targets
    .map((target) => ({ repositoryId: target.repositoryId, numbers: [...new Set(target.issueNumbers)] }))
    .filter((target) => target.numbers.length > 0);
  if (conditions.length === 0) return new Map();

  const rows = await db.issue.findMany({
    where: {
      OR: conditions.map((target) => ({
        repositoryId: target.repositoryId,
        number: { in: target.numbers },
      })),
      labels: { some: { name: CHECK_USER_LABEL } },
    },
    select: { repositoryId: true, number: true, labels: { select: { name: true } } },
  });

  return new Map(
    rows.map((row) => [
      checkUserIssueKey(row.repositoryId, row.number),
      checkUserReason(row.labels),
    ]),
  );
}
