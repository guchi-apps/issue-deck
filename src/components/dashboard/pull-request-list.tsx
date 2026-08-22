"use client";

import { useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Lock } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  BranchBadge,
  CiStateBadge,
  ConflictBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  RepairRunBadge,
  UserMergeRequiredBadge,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { autoRefreshIntervalLabel, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import {
  canMergeFromDeck,
  groupPullRequestsByRepository,
  requiresUserMerge,
} from "@/lib/pull-request-list";
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
  /** マージが成功したとき。マージ済みとして反映する・再取得するといった後始末は親が行う */
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

function PullRequestCard({
  pullRequest,
  selected,
  onSelect,
  onMerged,
}: {
  pullRequest: PullRequestSummary;
  selected: boolean;
  onSelect?: (pullRequest: PullRequestSummary) => void;
  onMerged: () => void;
}) {
  const kindLabel = pullRequestKindLabel(pullRequest.kind);
  // 一覧も`mergeable`を持つ（#1742）。CI状態と同じ1回のGraphQLで取っているので、
  // コンフリクトの表示と自動解消ボタンを出してもGitHub APIの消費は増えない。
  const repairKinds = repairKindsFor(pullRequest, pullRequest.mergeable);

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-l-4 border-l-transparent px-4 py-3 last:border-b-0",
        selected && "border-l-primary bg-accent",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <PullRequestStateIcon pullRequest={pullRequest} className="mt-0.5 size-4 shrink-0" />
        {/* 「#番号 タイトル」の並びはIssue一覧（issue-list.tsx）に揃えている。
            行末に番号を置くとタイトルが長いときに見切れて、PRの識別子が読めなくなるため。
            タイトルは詳細を開くボタンで、GitHubへは右のアイコンから開く（#1087）。 */}
        <button
          type="button"
          onClick={() => onSelect?.(pullRequest)}
          className="min-w-0 flex-1 text-left text-sm font-medium hover:underline"
        >
          #{pullRequest.number} {pullRequest.title}
        </button>
        <a
          href={pullRequest.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={`#${pullRequest.number} をGitHubで開く`}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pullRequest.draft ? (
          <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>
        ) : (
          <CiStateBadge ciState={pullRequest.ciState} />
        )}
        <ConflictBadge mergeable={pullRequest.mergeable} />
        {/* 失敗の赤の隣に「いま自動で直しにいっている」を出す（#2072）。 */}
        <RepairRunBadge run={pullRequest.repairRun} />
        {pullRequest.autoMergeEnabled && <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>}
        {requiresUserMerge(pullRequest) && <UserMergeRequiredBadge />}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <UserAvatar login={pullRequest.authorLogin} className="size-4" />
          {pullRequest.authorLogin}
        </span>
        <span className="text-xs text-muted-foreground">{formatRelativeDate(pullRequest.createdAt)}</span>
        <PullRequestRepairButtons
          repositoryFullName={pullRequest.repositoryFullName}
          pullRequestNumber={pullRequest.number}
          kinds={repairKinds}
          availability={pullRequest.repairWorkflowAvailability}
          runningKind={pullRequest.repairRun?.kind ?? null}
        />
        {canMergeFromDeck(pullRequest) && (
          <PullRequestMergeButton
            pullRequest={pullRequest}
            onMerged={onMerged}
            className="ml-auto"
          />
        )}
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
  onMerged,
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
            {/* 何分間隔で更新中なのかを画面に出す（#1767） */}
            {autoRefreshIntervalMs !== null && (
              <span>{` ・ 自動更新${autoRefreshIntervalLabel(autoRefreshIntervalMs)}`}</span>
            )}
          </p>
        </div>
        {/* ヘッダーに「更新」ボタンは置かない（#1947）。取り直しは自動更新（この画面を開いて
            いる間は10秒間隔）と、スマホの引っ張って更新が担う。Issue一覧のヘッダーと同じ形 */}
        {headerActions}
      </header>

      {/* 引っ張って更新（#1947）のタッチを受ける枠。**左右スワイプ（`listStyle`）は外側の枠、
          縦の引っ張りは内側のスクロール領域**と、transformを掛ける要素を分ける——同じ要素へ
          両方書くと、ビュー切り替えの追従と引っ張りの追従が互いを打ち消してしまう */}
      <div
        ref={pullContainerRef}
        className="relative flex min-h-0 flex-1 flex-col"
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
                    onMerged={() => onMerged?.(pullRequest)}
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
