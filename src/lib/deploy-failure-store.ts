import { db } from "@/lib/db";
import type { DeployFailureIssueRef } from "@/types/branch-flow";

/**
 * 自動起票したデプロイ失敗Issue（`DeployFailureIssue`）の読み出し（#2236）。
 *
 * **書き込みは巡回（`lib/github/deploy-failure-sweep-run.ts`）だけが行う。** ここに置くのは
 * 画面へ渡すための読み出しで、GitHub APIを一切叩かない——失敗の表示から追跡Issueへ移る
 * リンクを出すためだけに、デプロイ状況を取り直すたびにGitHubを叩きたくないため。
 */

function toRef(row: { repositoryFullName: string; issueNumber: number }): DeployFailureIssueRef {
  return {
    number: row.issueNumber,
    htmlUrl: `https://github.com/${row.repositoryFullName}/issues/${row.issueNumber}`,
  };
}

/** リポジトリ1件で開いている追跡Issue。無ければnull */
export async function findOpenDeployFailureIssue(
  repositoryFullName: string,
): Promise<DeployFailureIssueRef | null> {
  const row = await db.deployFailureIssue.findFirst({
    where: { repositoryFullName, state: "open" },
    orderBy: { detectedAt: "desc" },
    select: { repositoryFullName: true, issueNumber: true },
  });
  return row ? toRef(row) : null;
}

/**
 * 複数リポジトリぶんをまとめて引く（ブランチ画面向け）。
 * **同じリポジトリに複数行あっても1件に畳む**（新しいものを採る）。
 */
export async function findOpenDeployFailureIssues(
  repositoryFullNames: string[],
): Promise<Map<string, DeployFailureIssueRef>> {
  if (repositoryFullNames.length === 0) return new Map();

  const rows = await db.deployFailureIssue.findMany({
    where: { repositoryFullName: { in: repositoryFullNames }, state: "open" },
    orderBy: { detectedAt: "asc" },
    select: { repositoryFullName: true, issueNumber: true },
  });

  // 昇順で回して上書きするので、最後に残るのがいちばん新しい行になる。
  const byRepository = new Map<string, DeployFailureIssueRef>();
  for (const row of rows) byRepository.set(row.repositoryFullName, toRef(row));
  return byRepository;
}
