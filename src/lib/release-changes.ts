import { toPullRequestChanges, type PullRequestCommitSource } from "@/lib/pull-request-changes";
import type { ReleaseChangeCommit, ReleaseChangePullRequest } from "@/types/pull-request";

/**
 * リリース差分のコミットを、PR単位の一覧へ畳む（#4201）。
 *
 * 件名の解析は`toPullRequestChanges`（リリースPRの確認ダイアログと同じ）を使う。差分に
 * 含まれるコミットだけから求めるので、Issueのopen/closedや進捗には依存せず、本番に
 * 反映済みのPR・未マージのPRは入りようが無い。
 *
 * - 同じPR番号は1行にまとめる（マージコミットとsquashコミットが両方拾えた場合の重複）
 * - PR番号を特定できないコミットは`unknownCommits`へ分ける。PRとして並べず、かといって
 *   捨てもしない（捨てると「PRに紐づかない変更が本番へ出る」ことが見えなくなる）
 */
export function toReleaseChanges(commits: readonly PullRequestCommitSource[]): {
  pullRequests: ReleaseChangePullRequest[];
  unknownCommits: ReleaseChangeCommit[];
} {
  const pullRequests: ReleaseChangePullRequest[] = [];
  const unknownCommits: ReleaseChangeCommit[] = [];
  const seen = new Set<number>();

  for (const change of toPullRequestChanges(commits)) {
    if (change.pullRequestNumber === null) {
      unknownCommits.push({ sha: change.id, title: change.title });
      continue;
    }
    if (seen.has(change.pullRequestNumber)) continue;
    seen.add(change.pullRequestNumber);
    pullRequests.push({
      number: change.pullRequestNumber,
      title: change.title,
      issueNumber: change.issueNumber,
      isVersionBump: change.kind === "version-bump",
    });
  }

  return { pullRequests, unknownCommits };
}
