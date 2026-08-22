"use client";

import { GitPullRequest } from "lucide-react";

import {
  BranchBadge,
  CiStateBadge,
  ConflictBadge,
  MergeJudgementBadge,
} from "@/components/dashboard/pull-request-badges";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 「ユーザーの確認待ち」一覧の先頭に出す、ユーザーのマージを待っているPull Request（#1613）。
 *
 * develop→mainのリリースPRは対応Issueを持たないため、`00.check-user`を手掛かりにする確認待ちの
 * 一覧にはこれまで現れず、ブランチ画面かPR画面へ移らないと気づけなかった。マージという「人が
 * やること」は他の確認待ちと同じ性質なので、同じ場所に並べる。
 *
 * 何を出すかを決めるのは`pullRequestsAwaitingUserMerge`で、ここは受け取った分を描くだけ。
 * 空配列なら何も描かない（今までと同じ見た目に戻る）。
 */
export function MergePendingPullRequests({
  pullRequests,
  onSelectPullRequest,
}: {
  pullRequests: PullRequestSummary[];
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
}) {
  if (pullRequests.length === 0) return null;

  return (
    <section className="border-b bg-amber-500/5 px-4 py-3" aria-labelledby="merge-pending-title">
      <h3
        id="merge-pending-title"
        className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
      >
        <GitPullRequest className="size-3.5 shrink-0" />
        あなたのマージを待っているPull Request
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {pullRequests.map((pullRequest) => (
          <li key={pullRequest.id}>
            <button
              type="button"
              onClick={() => onSelectPullRequest(pullRequest)}
              className="flex w-full flex-col gap-1 rounded-md border bg-background px-2 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <span className="text-xs text-muted-foreground">
                {pullRequest.repositoryFullName.split("/")[1]}
              </span>
              <span className="line-clamp-2 text-sm font-medium">
                #{pullRequest.number} {pullRequest.title}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <BranchBadge baseRef={pullRequest.baseRef} headRef={pullRequest.headRef} />
                <CiStateBadge ciState={pullRequest.ciState} />
                <MergeJudgementBadge mergeJudgement={pullRequest.mergeJudgement} />
                <ConflictBadge mergeable={pullRequest.mergeable} />
                <span className="text-xs text-muted-foreground">
                  {formatRelativeDate(pullRequest.createdAt)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
