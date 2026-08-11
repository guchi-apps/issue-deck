"use client";

import type { CSSProperties } from "react";
import { ExternalLink, GitPullRequest, GitPullRequestDraft, Lock, RefreshCw } from "lucide-react";

import {
  BranchBadge,
  CiStateBadge,
  PullRequestMetaBadge,
  formatElapsed,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { canMergeFromDeck, groupPullRequestsByRepository } from "@/lib/pull-request-list";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { OpenPullRequest } from "@/types/pull-request";

type PullRequestListProps = {
  pullRequests: OpenPullRequest[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** 詳細を表示中のPRのid。未選択・詳細を持たない画面ではnull */
  selectedPullRequestId?: string | null;
  /** PRを選んだとき（詳細の表示）。渡さない場合もタイトルのリンクからGitHubは開ける */
  onSelectPullRequest?: (pullRequest: OpenPullRequest) => void;
  /** マージが成功したとき。一覧から伏せる・再取得するといった後始末は親が行う */
  onMerged?: (pullRequest: OpenPullRequest) => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる（#677と同じ理由） */
  footerSpacing?: boolean;
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function PullRequestCard({
  pullRequest,
  selected,
  onSelect,
  onMerged,
}: {
  pullRequest: OpenPullRequest;
  selected: boolean;
  onSelect?: (pullRequest: OpenPullRequest) => void;
  onMerged: () => void;
}) {
  const kindLabel = pullRequestKindLabel(pullRequest.kind);

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-l-4 border-l-transparent px-4 py-3 last:border-b-0",
        selected && "border-l-primary bg-accent",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {pullRequest.draft ? (
          <GitPullRequestDraft
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-label="ドラフト"
          />
        ) : (
          <GitPullRequest className="mt-0.5 size-4 shrink-0 text-green-600" aria-label="オープン" />
        )}
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
          <a
            href={`https://github.com/${pullRequest.repositoryFullName}/issues/${pullRequest.linkedIssueNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            Issue #{pullRequest.linkedIssueNumber}
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pullRequest.draft ? (
          <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>
        ) : (
          <CiStateBadge ciState={pullRequest.ciState} />
        )}
        {pullRequest.autoMergeEnabled && <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <UserAvatar login={pullRequest.authorLogin} className="size-4" />
          {pullRequest.authorLogin}
        </span>
        <span className="text-xs text-muted-foreground">{formatElapsed(pullRequest.createdAt)}</span>
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
 * マージ待ち（open）のPull Requestをリポジトリ横断で一覧表示する（#1058）。
 *
 * Issue一覧と違い、このデータはDBキャッシュではなく都度GitHub APIから取得している。
 * open PRは常時0〜数件しか存在しない運用のため、`PullRequest`テーブルとWebhook同期を
 * 持たずに済ませている（背景は docs/code-map.md を参照）。
 */
export function PullRequestList({
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  error,
  onRefresh,
  selectedPullRequestId = null,
  onSelectPullRequest,
  onMerged,
  headerLeading,
  className,
  style,
  footerSpacing = false,
}: PullRequestListProps) {
  const groups = groupPullRequestsByRepository(pullRequests);

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        {headerLeading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">マージ待ちPR</h1>
          <p className="truncate text-xs text-muted-foreground">
            <span>{pullRequests.length}件</span>
            {fetchedAt && <span>{` ・ ${formatTime(fetchedAt)}時点`}</span>}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0"
          disabled={isLoading}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
          更新
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

        {failedRepositories.length > 0 && (
          <p className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            取得できなかったリポジトリがあります: {failedRepositories.join(", ")}
          </p>
        )}

        {!error && pullRequests.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {isLoading ? "読み込み中..." : "マージ待ちのPull Requestはありません。"}
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
                  selected={selectedPullRequestId === pullRequest.id}
                  onSelect={onSelectPullRequest}
                  onMerged={() => onMerged?.(pullRequest)}
                />
              ))}
            </ul>
          </section>
        ))}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
