"use client";

import { Clock, GitPullRequest, RefreshCw } from "lucide-react";

import {
  BranchBadge,
  CiStateBadge,
  ConflictBadge,
  MergeJudgementBadge,
} from "@/components/dashboard/pull-request-badges";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";
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
 *
 * **並ぶのはいま押せるPRだけで、CI実行中・判定中のものは`waitingForChecksCount`として
 * 件数だけ受け取る**（#2081）。押せないPRを並べても開いた先に操作が無く、リリースPRを
 * 一斉に起票した直後はそれで一覧が埋まっていた。ただし完全に消すと、対応Issueを持たない
 * リリースPRはどこにも現れないまま数分後に突然現れるため、最後の1行で件数だけ伝える。
 */
export function MergePendingPullRequests({
  pullRequests,
  waitingForChecksCount = 0,
  onSelectPullRequest,
  onRefresh,
  isRefreshing = false,
}: {
  pullRequests: PullRequestSummary[];
  /** CI・判定の完了待ちで一覧から外したPRの件数（#2081）。0なら完了待ちの行を出さない */
  waitingForChecksCount?: number;
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  /**
   * 見出しの「更新」でのPRの取り直し（#2175）。渡さなければボタンを出さない。
   *
   * **一覧を下へ引っ張れないPCのために要る。** 確認待ちのビューではPRの自動更新を
   * 止めている（`usePullRequests`に間隔を渡すのはPR画面とブランチ画面だけ）ため、
   * ここに並ぶPRは画面を開いた時点のままになる。
   */
  onRefresh?: () => void;
  /** 取り直しが飛んでいる間の表示（アイコンの回転）。`onRefresh`が無いときは使わない */
  isRefreshing?: boolean;
}) {
  if (pullRequests.length === 0 && waitingForChecksCount === 0) return null;

  // 押せるPRが1件も無いときは、見出しごと薄い1行に落とす。「あなたのマージを待っている」の
  // 見出しの下に何も並ばない状態は、待たれているのに開けないものがあるように読めるため。
  if (pullRequests.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          <WaitingForChecksText count={waitingForChecksCount} />
        </p>
        <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
      </div>
    );
  }

  return (
    <section className="border-b bg-amber-500/5 px-4 py-3" aria-labelledby="merge-pending-title">
      <div className="flex items-center gap-2">
        <h3
          id="merge-pending-title"
          className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
        >
          <GitPullRequest className="size-3.5 shrink-0" />
          あなたのマージを待っているPull Request
        </h3>
        <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
      </div>
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
      {waitingForChecksCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          <WaitingForChecksText count={waitingForChecksCount} />
        </p>
      )}
    </section>
  );
}

/**
 * 見出しの右へ置く「更新」（#2175）。`onRefresh`を渡されていない画面では何も描かない。
 *
 * **スマホの「引っ張って更新」と同じ取り直しを、指で引けないPCから呼ぶためのもの。**
 * 文言・アイコン・回転はPR詳細（`pull-request-detail.tsx`）の更新ボタンに合わせている。
 */
function RefreshButton({
  onRefresh,
  isRefreshing,
}: {
  onRefresh?: () => void;
  isRefreshing: boolean;
}) {
  if (!onRefresh) return null;

  return (
    <Button
      size="xs"
      variant="ghost"
      className="ml-auto shrink-0 text-muted-foreground"
      disabled={isRefreshing}
      onClick={onRefresh}
    >
      <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
      更新
    </Button>
  );
}

/**
 * 一覧から外したPRの件数を伝える1行（#2081）。**件数には足さない**——左メニュー・
 * ホームの「要対応」が数えるのは、いま人が押せば盤面が進むものだけ（#1763の手作業待ちが
 * 前提待ちを件数から外しているのと同じ扱い）。
 */
function WaitingForChecksText({ count }: { count: number }) {
  return (
    <>
      <Clock className="mr-1 inline-block size-3 shrink-0 align-[-0.125em]" />
      CI・判定の完了待ちが{count}件あります（終わるとここに並びます）
    </>
  );
}
