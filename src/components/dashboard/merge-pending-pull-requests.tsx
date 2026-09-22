"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, CircleDot, Clock, GitPullRequest, RefreshCw } from "lucide-react";

import { BranchBadge } from "@/components/dashboard/pull-request-badges";
import { PullRequestStatusRail } from "@/components/dashboard/pull-request-status-rail";
import { SnoozeMenu } from "@/components/dashboard/snooze-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { isLinkedIssueListed } from "@/lib/pull-request-list";
import {
  describeSnoozeUntil,
  findActiveSnooze,
  type SnoozeMap,
  type SnoozeTarget,
} from "@/lib/snooze";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 畳んだときに並べる件数（#3165）。スマホ（iPhone 15・393×852）で見出し・3件・「他N件を表示」
 * を足して画面のおよそ半分に収まり、下に確認待ちのIssueが2件見える数。
 */
const COLLAPSED_COUNT = 3;

/**
 * 「ユーザーの確認待ち」一覧の先頭に出す、ユーザーのマージを待っているPull Request（#1613）。
 *
 * develop→mainのリリースPRは対応Issueを持たないため、`00.check-user`を手掛かりにする確認待ちの
 * 一覧にはこれまで現れず、ブランチ画面かPR画面へ移らないと気づけなかった。マージという「人が
 * やること」は他の確認待ちと同じ性質なので、同じ場所に並べる。
 *
 * **対応Issueが同じ一覧に並んでいるdevelop向けPRも並ぶ**（#3345）。以前は二重表示を避けて
 * 外しており、枠にはリリースPRしか出なかった。同じ案件だと読めるよう、そのカードには
 * 「対応Issue」のチップを付ける（`listedIssueKeys`）。
 *
 * 何を出すかを決めるのは`pullRequestsAwaitingUserMerge`で、ここは受け取った分を描くだけ。
 * 空配列なら何も描かない（今までと同じ見た目に戻る）。
 *
 * **並ぶのはいま押せるPRだけで、CI実行中・判定中のものは`waitingForChecksCount`として
 * 件数だけ受け取る**（#2081）。押せないPRを並べても開いた先に操作が無く、リリースPRを
 * 一斉に起票した直後はそれで一覧が埋まっていた。ただし完全に消すと、対応Issueを持たない
 * リリースPRはどこにも現れないまま数分後に突然現れるため、最後の1行で件数だけ伝える。
 *
 * **既定で並べるのは`COLLAPSED_COUNT`件までで、残りは「他N件を表示」の1行にまとめる**
 * （#3165）。リリースPRを各リポジトリへ一斉に起票した日は10件を超え、枠だけで画面が埋まって
 * 確認待ちのIssueが1件も見えなくなっていた。**件数は見出しのバッジで必ず出す**ので、
 * 畳んでいても何件待たれているかは分かる。
 */
export function MergePendingPullRequests({
  pullRequests,
  listedIssueKeys,
  waitingForChecksCount = 0,
  onSelectPullRequest,
  onSnooze,
  now = null,
  snoozed,
  onRefresh,
  isRefreshing = false,
}: {
  pullRequests: PullRequestSummary[];
  /**
   * 確認待ちに並んでいるIssue（`checkUserIssueKeys`。#3345）。対応Issueがここに含まれるPRの
   * カードに「対応Issue #N・下の一覧にもあります」を出す。渡さなければ出さない
   */
  listedIssueKeys?: ReadonlySet<string>;
  /** CI・判定の完了待ちで一覧から外したPRの件数（#2081）。0なら完了待ちの行を出さない */
  waitingForChecksCount?: number;
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  /**
   * 「いまは実施しない」（#2398）。渡すとカードに時計ボタンが出る。
   * **選択肢はIssueの行と同じ`SnoozeMenu`**で、開く場所によって中身が変わらないようにする。
   */
  onSnooze?: (target: SnoozeTarget, until: string | null) => void;
  /** 現在時刻(epoch ms)。保留メニューの日付の組み立てに使う */
  now?: number | null;
  /**
   * 保留中のPRを並べる側として描くか（#2398）。渡すと見出しを出さず、各カードに
   * 期限と「解除」を添えた薄い並びになる（一覧の「保留中N件」を開いた中身）。
   */
  snoozed?: {
    /** 期限を引くための引き当て表（`buildSnoozeMap`） */
    snoozes: SnoozeMap;
    now: number | null;
    onUnsnooze: (target: SnoozeTarget) => void;
  };
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
  // 畳んだ状態の開閉（#3165）。**覚えない**——Issueを開いて戻ると畳んだ状態に戻る。
  // 開いたままにすると、次に来たときにまた枠で画面が埋まる（それが直したかった状態）
  const [isExpanded, setIsExpanded] = useState(false);

  if (pullRequests.length === 0 && waitingForChecksCount === 0) return null;

  // 保留中のPRは、一覧の「保留中N件」を開いた中に並ぶ（#2398）。見出しも件数の行も出さない
  // ——それらは開いた側（`IssueList`）が1行にまとめて持っている
  if (snoozed) {
    return (
      <ul className="flex flex-col">
        {pullRequests.map((pullRequest) => (
          <li key={pullRequest.id} className="flex items-center gap-2 border-b px-4 py-2.5">
            <button
              type="button"
              onClick={() => onSelectPullRequest(pullRequest)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate text-xs text-muted-foreground">
                {pullRequest.repositoryFullName.split("/")[1]}
              </span>
              <span className="line-clamp-2 text-sm text-muted-foreground">
                #{pullRequest.number} {pullRequest.title}
              </span>
            </button>
            <span className="flex shrink-0 items-center gap-1.5">
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Clock className="size-3" />
                {describeSnoozeUntil(
                  findActiveSnooze(
                    snoozed.snoozes,
                    {
                      kind: "pull-request",
                      repositoryFullName: pullRequest.repositoryFullName,
                      number: pullRequest.number,
                    },
                    snoozed.now,
                  )?.until ?? null,
                  snoozed.now,
                )}
              </Badge>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  snoozed.onUnsnooze({
                    kind: "pull-request",
                    repositoryFullName: pullRequest.repositoryFullName,
                    number: pullRequest.number,
                  })
                }
              >
                解除
              </Button>
            </span>
          </li>
        ))}
      </ul>
    );
  }

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

  // 畳むのは`COLLAPSED_COUNT`を超えたときだけ。1件だけ隠しても画面は広がらず、
  // 押す手間だけが増える
  const isCollapsible = pullRequests.length > COLLAPSED_COUNT;
  const hiddenCount = isCollapsible ? pullRequests.length - COLLAPSED_COUNT : 0;
  const listedPullRequests =
    isCollapsible && !isExpanded ? pullRequests.slice(0, COLLAPSED_COUNT) : pullRequests;

  return (
    <section className="border-b bg-amber-500/5 px-4 py-3" aria-labelledby="merge-pending-title">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          id="merge-pending-title"
          className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
        >
          <GitPullRequest className="size-3.5 shrink-0" />
          あなたのマージを待っているPull Request
          {/* 畳んでいるときも「何件待たれているか」だけは必ず読める（#3165）。
              出すのは並べている数ではなく総数で、左メニューの数え方と同じ */}
          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 font-semibold tabular-nums">
            {pullRequests.length}件
          </span>
        </h3>
        <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
      </div>
      <ul id="merge-pending-list" className="mt-2 flex flex-col gap-1.5">
        {listedPullRequests.map((pullRequest) => (
          <li key={pullRequest.id} className="relative">
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
                <span className="text-xs text-muted-foreground">
                  {formatRelativeDate(pullRequest.createdAt)}
                </span>
              </span>
              {/* 同じ案件が下のIssue行にもあることを示す（#3345）。件数にはIssue側の1件だけを
                  数えているので、ここで2件あるように見せない */}
              {listedIssueKeys && isLinkedIssueListed(pullRequest, listedIssueKeys) && (
                <span className="inline-flex items-center gap-1 self-start rounded bg-sky-500/10 px-1.5 text-xs text-sky-700 dark:text-sky-400">
                  <CircleDot className="size-3 shrink-0" />
                  対応Issue #{pullRequest.linkedIssueNumber}・下の一覧にもあります
                </span>
              )}
              {/* PR一覧と同じステータスレール（#2942）。同じPRなのに画面ごとに違う出し方に
                  なると、どちらが新しいのかを読む側が判断できなくなる（#2145と同じ理由） */}
              <PullRequestStatusRail pullRequest={pullRequest} linkable={false} />
            </button>
            {/* 「いまは実施しない」（#2398）。カード全体が<button>なので、その外へ重ねて置く */}
            {onSnooze && (
              <div className="absolute top-1.5 right-1.5">
                <SnoozeMenu
                  target={{
                    kind: "pull-request",
                    repositoryFullName: pullRequest.repositoryFullName,
                    number: pullRequest.number,
                  }}
                  onSnooze={onSnooze}
                  now={now}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {isCollapsible && (
        <Button
          size="xs"
          variant="outline"
          className="mt-1.5 w-full bg-background"
          aria-expanded={isExpanded}
          aria-controls="merge-pending-list"
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="size-3.5" />
              先頭{COLLAPSED_COUNT}件だけ表示
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" />他{hiddenCount}件を表示
            </>
          )}
        </Button>
      )}
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
