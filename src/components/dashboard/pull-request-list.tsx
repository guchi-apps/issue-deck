"use client";

import { useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Lock } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  BranchBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  RepairRunBadge,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeHoldNotice } from "@/components/dashboard/pull-request-merge-hold";
import { PullRequestChecksStrip } from "@/components/dashboard/pull-request-checks-strip";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { describeAutoRefreshState, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { groupPullRequestsByRepository } from "@/lib/pull-request-list";
import { derivePrimaryState, type PrimaryStateTone } from "@/lib/pull-request-primary-state";
import { getPullRequestView } from "@/lib/pull-request-views";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

type PullRequestListProps = {
  /** 表示中の状態別ビュー（#1312）。見出し・空状態の文言・並び順がこれで決まる */
  view: PullRequestViewId;
  pullRequests: PullRequestSummary[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  /**
   * 自動更新の間隔（#1767）。`null`＝自動更新しない。この一覧では設定できず、
   * 「いま何分間隔で更新中か」を出すためだけに受け取る（決めるのは`issue-deck-shell.tsx`）。
   */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
  error: string | null;
  /**
   * 一覧を下へ引っ張ったときに実行する更新（#1947）。**渡した画面でだけ有効になる。**
   * 引っ張るという操作はタッチにしか無いため、PCのPRペインは渡さない
   * （`IssueList`の`onPullToRefresh`と同じ扱い）。
   */
  onPullToRefresh?: () => Promise<unknown> | void;
  /** 詳細を表示中のPRのid。未選択・詳細を持たない画面ではnull */
  selectedPullRequestId?: string | null;
  /** PRを選んだとき（詳細の表示）。渡さない場合もタイトルのリンクからGitHubは開ける */
  onSelectPullRequest?: (pullRequest: PullRequestSummary) => void;
  /**
   * 互換のために受け取るだけで、この一覧は使わない（#4427）。マージ・自動修正の操作は詳細の
   * 主操作へ集約したため、一覧からマージが成功することは無い
   */
  onMerged?: (pullRequest: PullRequestSummary) => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  /** ヘッダーの右端に置くボタン（スマホの実行状況。#1638。PCからは渡さない） */
  headerActions?: React.ReactNode;
  /** 一覧の下端に固定する行（スマホのビュー切り替え。#1691。PCからは渡さない） */
  footer?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * 一覧本体（スクロール領域）だけに掛けるスタイル（#1691）。スマホのスワイプで
   * ビューを切り替えるとき、ヘッダーと下端の行は動かさず一覧だけを指に追従させる。
   */
  listStyle?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる（#677と同じ理由） */
  footerSpacing?: boolean;
};

const PRIMARY_TONE_CLASS: Record<PrimaryStateTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  bad: "text-destructive",
  warn: "text-amber-700 dark:text-amber-400",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/**
 * 一覧の1行（#4427）。上から「リポジトリ・番号 → タイトル → 代表状態と理由 → 6チェック → 詳細への導線」。
 * マージ・自動修正の操作は詳細の主操作へ集約し、ここには置かない（一覧は状態を読んで詳細へ進む場所）。
 * 自動マージの保留・警告は理由の直下に残す。
 */
function PullRequestCard({
  pullRequest,
  selected,
  onSelect,
}: {
  pullRequest: PullRequestSummary;
  selected: boolean;
  onSelect?: (pullRequest: PullRequestSummary) => void;
}) {
  const kindLabel = pullRequestKindLabel(pullRequest.kind);
  const primary = derivePrimaryState(pullRequest);

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-l-4 border-l-transparent px-4 py-3 last:border-b-0",
        selected && "border-l-primary bg-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <PullRequestStateIcon pullRequest={pullRequest} className="size-4 shrink-0" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {pullRequest.repositoryFullName}
          <span className="ml-1.5 font-medium text-foreground">#{pullRequest.number}</span>
        </p>
        <a
          href={pullRequest.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={`#${pullRequest.number} をGitHubで開く`}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      {/* タイトルは詳細を開くボタン。番号は上の行にあるので、読み上げ用のラベルにだけ含める（#1087） */}
      <button
        type="button"
        onClick={() => onSelect?.(pullRequest)}
        aria-label={`#${pullRequest.number} ${pullRequest.title}`}
        className="min-w-0 text-left text-sm font-semibold leading-snug break-words hover:underline"
      >
        {pullRequest.title}
      </button>

      {/* 代表状態と理由。色だけに頼らず記号と日本語を併記する */}
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1" data-testid="pull-request-primary-state">
        <span className={cn("text-xs font-bold", PRIMARY_TONE_CLASS[primary.tone])}>
          <span aria-hidden="true">{primary.mark}</span> {primary.label}
        </span>
        <RepairRunBadge run={pullRequest.repairRun} compact />
        <span className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">{primary.reason}</span>
      </div>
      <PullRequestMergeHoldNotice pullRequest={pullRequest} />

      {/* PR詳細・ブランチ画面と同じ6チェック（#4366）。一覧では2グループに分け、候補の版・PR番号を見出しに添える */}
      <PullRequestChecksStrip
        pullRequest={pullRequest}
        onOpenPullRequest={onSelect ? () => onSelect(pullRequest) : null}
        className="-mx-1 px-0"
      />

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {onSelect && (
          <button
            type="button"
            onClick={() => onSelect(pullRequest)}
            className="flex min-h-11 items-center text-xs font-semibold text-primary hover:underline"
          >
            詳細を開く ›
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <BranchBadge baseRef={pullRequest.baseRef} headRef={pullRequest.headRef} />
          {kindLabel && <PullRequestMetaBadge>{kindLabel}</PullRequestMetaBadge>}
          {pullRequest.linkedIssueNumber !== null && (
            <GithubReferenceLink
              href={`https://github.com/${pullRequest.repositoryFullName}/issues/${pullRequest.linkedIssueNumber}`}
              reference={{
                repositoryFullName: pullRequest.repositoryFullName,
                number: pullRequest.linkedIssueNumber,
                kind: "issue",
              }}
              className="text-xs text-primary hover:underline"
            >
              Issue #{pullRequest.linkedIssueNumber}
            </GithubReferenceLink>
          )}
          <span className="flex items-center gap-1">
            <UserAvatar login={pullRequest.authorLogin} className="size-4" />
            {pullRequest.authorLogin}
          </span>
          <span>{formatRelativeDate(pullRequest.createdAt)}</span>
        </div>
      </div>
    </li>
  );
}

/**
 * Pull Requestをリポジトリ横断で一覧表示する（#1058）。何を集めた一覧かは`view`が決める（#1312）。
 *
 * Issue一覧と違い、このデータはDBキャッシュではなく都度GitHub APIから取得している。
 * open PRは常時0〜数件しか存在しない運用のため、`PullRequest`テーブルとWebhook同期を
 * 持たずに済ませている（背景は docs/code-map.md を参照）。
 */
export function PullRequestList({
  view,
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  autoRefreshIntervalMs = null,
  error,
  onPullToRefresh,
  selectedPullRequestId = null,
  onSelectPullRequest,
  headerLeading,
  headerActions,
  footer,
  className,
  style,
  listStyle,
  footerSpacing = false,
}: PullRequestListProps) {
  const groups = groupPullRequestsByRepository(pullRequests, view);
  const { title, description, emptyMessage } = getPullRequestView(view);

  // 押した行を即座にハイライトするための楽観表示（#1597）。Issue一覧（issue-list.tsx）と
  // 同じ仕組みで、理由もそちらのコメントに書いてある。
  const [optimisticSelectedId, setOptimisticSelectedId] = useState<string | null>(null);
  const [syncedSelectedId, setSyncedSelectedId] = useState(selectedPullRequestId);
  if (selectedPullRequestId !== syncedSelectedId) {
    setSyncedSelectedId(selectedPullRequestId);
    setOptimisticSelectedId(null);
  }
  const highlightedId = optimisticSelectedId ?? selectedPullRequestId;

  // 引っ張って更新（#1893・#1947）。**タッチを受けるのはスクロール領域そのものではなく
  // それを包む枠**で、スクロール位置は中のスクロール領域を見る（`use-pull-to-refresh.ts`）。
  const pullContainerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    containerRef: pullContainerRef,
    scrollRef,
    onRefresh: onPullToRefresh,
  });

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        {headerLeading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" title={description}>
            {title}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            <span>{pullRequests.length}件</span>
            {fetchedAt && <span>{` ・ ${formatTimeOfDay(fetchedAt)}時点`}</span>}
            {/* 何分間隔で更新中なのかを画面に出す（#1767）。**自動更新していないときも黙らない**
                （#1797）——何も出ないと「自動更新していない」のか「この画面は状態を出さない」のかを
                見分けられない。文言はIssue一覧・ブランチ画面と共通 */}
            <span>{` ・ ${describeAutoRefreshState(autoRefreshIntervalMs)}`}</span>
          </p>
        </div>
        {/* ヘッダーに「更新」ボタンは置かない（#1947）。取り直しは自動更新（この画面を開いて
            いる間は10秒間隔）と、スマホの引っ張って更新が担う。Issue一覧のヘッダーと同じ形 */}
        {headerActions}
      </header>

      {/* 引っ張って更新（#1947）のタッチを受ける枠。**左右スワイプ（`listStyle`）は外側の枠、
          縦の引っ張りは内側のスクロール領域**と、transformを掛ける要素を分ける——同じ要素へ
          両方書くと、ビュー切り替えの追従と引っ張りの追従が互いを打ち消してしまう */}
      {/* `overflow-hidden`は引っ張ったぶんのはみ出しを切り抜くため（#2885。理由は
          `issue-list.tsx`の同じ枠のコメントを参照） */}
      <div
        ref={pullContainerRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        style={listStyle}
      >
        <PullToRefreshIndicator pull={pull} />

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={{
            transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
          {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

          {failedRepositories.length > 0 && (
            <p className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              取得できなかったリポジトリがあります: {failedRepositories.join(", ")}
            </p>
          )}

          {!error && pullRequests.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {isLoading ? "読み込み中..." : emptyMessage}
            </p>
          )}

          {groups.map((group) => (
            <section key={group.repositoryFullName}>
              <h2 className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-2 text-xs font-semibold backdrop-blur">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: getRepoColor(group.repositoryFullName) }}
                  aria-hidden="true"
                />
                <span className="truncate">{group.repositoryFullName}</span>
                {group.repositoryPrivate && (
                  <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
                )}
                <span className="ml-auto shrink-0 font-normal text-muted-foreground">
                  {group.pullRequests.length}
                </span>
              </h2>
              <ul>
                {group.pullRequests.map((pullRequest) => (
                  <PullRequestCard
                    key={pullRequest.id}
                    pullRequest={pullRequest}
                    selected={highlightedId === pullRequest.id}
                    onSelect={
                      onSelectPullRequest &&
                      ((selectedPullRequest) => {
                        setOptimisticSelectedId(selectedPullRequest.id);
                        onSelectPullRequest(selectedPullRequest);
                      })
                    }
                  />
                ))}
              </ul>
            </section>
          ))}

          {footerSpacing && <div className="h-14" aria-hidden="true" />}
        </div>
      </div>

      {footer}
    </div>
  );
}
