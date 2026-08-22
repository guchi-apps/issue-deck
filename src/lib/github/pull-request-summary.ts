import { buildPullRequestId } from "@/lib/github-reference";
import type { CheckUserReason } from "@/lib/github/approval-labels";
import { MERGE_JUDGEMENT_UNKNOWN, type MergeJudgement } from "@/lib/github/check-rollup";
import type { RepairWorkflowAvailability } from "@/lib/github/pull-request-repair";
import type { PullRequestRepairRunSummary } from "@/lib/github/pull-request-repair-run";
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
 * CI状態とコンフリクト有無（`mergeable`。#1742）は呼び出し側が渡す。取得にPR1件あたり1回APIを
 * 消費するので、「いつ取るか」の判断（draftやclosedでは取らない）は経路ごとに違うため。
 * この2つと自動マージ可否の判定の進み具合（`mergeJudgement`。#1968）は、1回のGraphQLで
 * まとめて取れる（`fetchPullRequestCiState`）。
 *
 * 対応Issueの`00.check-user`（`linkedIssueCheckUser`）とその理由（`linkedIssueCheckReason`。
 * #1490）も呼び出し側が渡す。DBキャッシュを引く処理で、一覧は全リポジトリぶんをまとめて
 * 1クエリ・詳細は1件だけと引き方が違うため（`src/lib/pull-request-check-user.ts`）。
 * 省略した場合は`false` / `null`（付いていない・理由が読めない扱い）。
 *
 * 自動修復ワークフローの配布状況（`repairWorkflowAvailability`。#1960）も同じく呼び出し側が
 * 渡す。**修復ボタンを出すPRでしか判定しない**ため、いつ問い合わせるかは経路ごとに違う。
 * いま走っている自動修復（`repairRun`。#2072）も同じ扱いで、材料がGitHubではなくissue-deckの
 * DBのため、一覧はまとめて1クエリ・詳細は1件だけと引き方が違う。
 */
export function toPullRequestSummary(
  pullRequest: GithubApiOpenPullRequest,
  repository: { fullName: string; private: boolean },
  options: {
    merged: boolean;
    ciState: CiState;
    /** コンフリクト有無。取得していない経路（draft・closed）では省略＝`null` */
    mergeable?: boolean | null;
    /** 自動マージ可否の判定の進み具合（#1968）。取得していない経路では省略＝`unknown` */
    mergeJudgement?: MergeJudgement;
    linkedIssueCheckUser?: boolean;
    linkedIssueCheckReason?: CheckUserReason | null;
    /** 修復ワークフローの配布状況。判定していない経路では省略＝`{}`（押せる扱い） */
    repairWorkflowAvailability?: RepairWorkflowAvailability;
    /** いま走っている自動修復（#2072）。引いていない経路では省略＝`null`（何も出さない） */
    repairRun?: PullRequestRepairRunSummary | null;
  },
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
    linkedIssueCheckUser: options.linkedIssueCheckUser ?? false,
    linkedIssueCheckReason: options.linkedIssueCheckReason ?? null,
    ciState: options.ciState,
    mergeJudgement: options.mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN,
    mergeable: options.mergeable ?? null,
    repairWorkflowAvailability: options.repairWorkflowAvailability ?? {},
    repairRun: options.repairRun ?? null,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
  };
}
