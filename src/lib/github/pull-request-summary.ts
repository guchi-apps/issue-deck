import { buildPullRequestId } from "@/lib/github-reference";
import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";
import type { CiState } from "@/lib/github/release-api";
import { classifyPullRequest, extractLinkedIssueNumber } from "@/lib/pull-request-list";
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
 *
 * 対応Issueの`00.check-user`（`linkedIssueCheckUser`）も呼び出し側が渡す。DBキャッシュを引く
 * 処理で、一覧は全リポジトリぶんをまとめて1クエリ・詳細は1件だけと引き方が違うため
 * （`src/lib/pull-request-check-user.ts`）。省略した場合は`false`（付いていない扱い）。
 */
export function toPullRequestSummary(
  pullRequest: GithubApiOpenPullRequest,
  repository: { fullName: string; private: boolean },
  options: { merged: boolean; ciState: CiState; linkedIssueCheckUser?: boolean },
): PullRequestSummary {
  const baseRef = pullRequest.base.ref;
  const headRef = pullRequest.head.ref;

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
    baseRef,
    headRef,
    kind: classifyPullRequest({ baseRef, headRef }),
    linkedIssueNumber: extractLinkedIssueNumber({
      headRef,
      title: pullRequest.title,
      body: pullRequest.body,
    }),
    autoMergeEnabled: pullRequest.auto_merge !== null,
    linkedIssueCheckUser: options.linkedIssueCheckUser ?? false,
    ciState: options.ciState,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
  };
}
