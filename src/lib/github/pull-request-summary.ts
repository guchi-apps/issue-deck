import { buildPullRequestId } from "@/lib/github-reference";
import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";
import type { CiState } from "@/lib/github/release-api";
import { classifyPullRequest, extractLinkedIssueNumbers } from "@/lib/pull-request-list";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * GitHub APIのPRを画面用の`PullRequestSummary`へ変換する。
 *
 * 一覧（`/api/pull-requests`）と詳細（`/api/pull-requests/detail`）の両方が同じ形を返す
 * 必要があるため共通化している（#1260）。詳細はリンクから直接開かれることがあり、その場合は
 * 一覧の項目が存在しないので、ヘッダーの材料をここで作った`summary`だけで賄う。
 *
 * CI状態は呼び出し側が渡す。取得にPR1件あたり1回APIを消費するので、「いつ取るか」の判断
 * （draftやclosedでは取らない）は経路ごとに違うため。
 */
export function toPullRequestSummary(
  pullRequest: GithubApiOpenPullRequest,
  repository: { fullName: string; private: boolean },
  options: { merged: boolean; ciState: CiState },
): PullRequestSummary {
  const baseRef = pullRequest.base.ref;
  const headRef = pullRequest.head.ref;
  // 1本のPRが複数のIssueを扱うことがあるため、参照はすべて拾って確度の高い順に持つ（#1455）。
  // 本文までは画面へ送らないので、抽出はこの層で済ませる。
  const linkedIssueNumbers = extractLinkedIssueNumbers({
    headRef,
    title: pullRequest.title,
    body: pullRequest.body,
  });

  return {
    id: buildPullRequestId(repository.fullName, pullRequest.number),
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    number: pullRequest.number,
    title: pullRequest.title,
    htmlUrl: pullRequest.html_url,
    authorLogin: pullRequest.user?.login ?? "unknown",
    draft: pullRequest.draft,
    state: pullRequest.state === "closed" ? "closed" : "open",
    merged: options.merged,
    mergedAt: pullRequest.merged_at,
    baseRef,
    headRef,
    kind: classifyPullRequest({ baseRef, headRef }),
    linkedIssueNumber: linkedIssueNumbers[0] ?? null,
    linkedIssueNumbers,
    autoMergeEnabled: pullRequest.auto_merge !== null,
    ciState: options.ciState,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
  };
}
