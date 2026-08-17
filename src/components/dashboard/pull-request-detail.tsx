"use client";

import type { CSSProperties } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import {
  BranchBadge,
  CiStateBadge,
  ConflictBadge,
  DeployStatusBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  UserMergeRequiredBadge,
  formatElapsed,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePullRequestDeployStatus } from "@/hooks/use-pull-request-deploy-status";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import { canMergeFromDeck, requiresUserMerge } from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type {
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
  PullRequestEvent,
  PullRequestReviewState,
} from "@/types/pull-request";

type PullRequestDetailProps = {
  /** 一覧で選択中のPR。未選択ならnull */
  pullRequest: PullRequestSummary | null;
  /** 本文・コメント。取得前・取得失敗時はnull */
  detail: PullRequestDetailData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMerged: () => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる */
  footerSpacing?: boolean;
};

const REVIEW_STATE_LABEL: Record<PullRequestReviewState, string> = {
  approved: "承認",
  changes_requested: "変更を要求",
  commented: "コメント",
  dismissed: "取り消し済み",
};

function ReviewStateBadge({ reviewState }: { reviewState: PullRequestReviewState }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        reviewState === "approved"
          ? "bg-green-600/15 text-green-700 ring-green-600 dark:text-green-400"
          : reviewState === "changes_requested"
            ? "bg-destructive/15 text-destructive ring-destructive"
            : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {REVIEW_STATE_LABEL[reviewState]}
    </span>
  );
}

function EventItem({
  event,
  repositoryFullName,
}: {
  event: PullRequestEvent;
  repositoryFullName: string;
}) {
  return (
    <li className="border-b px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <UserAvatar login={event.authorLogin} className="size-4" />
        <span className="font-medium text-foreground">{event.authorLogin}</span>
        {event.kind === "review" && event.reviewState && (
          <ReviewStateBadge reviewState={event.reviewState} />
        )}
        {event.kind === "review-comment" && event.path && (
          <code className="min-w-0 truncate rounded bg-muted px-1 py-0.5">
            {event.path}
            {event.line !== null ? `:${event.line}` : ""}
          </code>
        )}
        <span className="shrink-0">{formatRelativeDate(event.createdAt)}</span>
      </div>
      {event.body.trim() ? (
        <MarkdownBody
          content={event.body}
          className="mt-2"
          repositoryFullName={repositoryFullName}
        />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">（本文なし）</p>
      )}
    </li>
  );
}

/**
 * 選択中PRの本文・コメントを表示する（#1087）。
 *
 * ヘッダーに出す情報（タイトル・ブランチ・CI状態・作者）は`PullRequestSummary`から描く。
 * 一覧から選んだ場合は一覧が既に持っているものをそのまま使うので、PRを選んでから表示までが速い。
 * 画面内のリンクから直接開いた場合は一覧に項目が無いため、詳細APIが返す`summary`が親経由で
 * 渡ってくる（#1260）。
 */
export function PullRequestDetail({
  pullRequest,
  detail,
  isLoading,
  error,
  onRefresh,
  onMerged,
  headerLeading,
  className,
  style,
  footerSpacing = false,
}: PullRequestDetailProps) {
  // 本番へ届いたか（#1814）。マージ済みのPRでだけ取りに行く。ヘッダーの「更新」でも
  // 取り直したいので、詳細の取得時刻をキーに渡す。スマホのPR詳細画面もこの部品を使うため、
  // ここで持つことでPC・スマホの両方に同じ表示が出る。
  const deployStatus = usePullRequestDeployStatus(
    pullRequest?.id ?? null,
    pullRequest?.merged ?? false,
    detail?.fetchedAt ?? null,
  );

  // 画面内のリンクから一覧に無いPRを開いた場合、ヘッダーの材料（summary）が届くまで
  // 選択中PRはnullのまま。「PRを選ぶと〜」ではなく読み込み中・失敗として見せる（#1260）。
  if (!pullRequest) {
    return (
      <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          {headerLeading}
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-foreground">
            {error ? "Pull Requestを開けませんでした" : isLoading ? "読み込み中..." : "Pull Request"}
          </p>
        </header>
        {error ? (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            PRを選ぶと本文とコメントを表示します。
          </p>
        )}
      </div>
    );
  }

  const kindLabel = pullRequestKindLabel(pullRequest.kind);
  // 取得結果が選択中PRのものか（切り替え直後に前のPRの本文を出さないための保険）
  const currentDetail = detail && detail.id === pullRequest.id ? detail : null;
  // `mergeable`は一覧・詳細のどちらの`summary`にも入っている（#1742）ので、CI失敗と
  // コンフリクトの両方の修復ボタンを出せる（#1293）。
  const repairKinds = repairKindsFor(pullRequest, pullRequest.mergeable);

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <header className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
        {headerLeading}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <PullRequestStateIcon pullRequest={pullRequest} className="mt-0.5 size-4 shrink-0" />
            <h1 className="min-w-0 flex-1 text-sm font-semibold">
              #{pullRequest.number} {pullRequest.title}
            </h1>
            <a
              href={pullRequest.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={`#${pullRequest.number} をGitHubで開く`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {pullRequest.repositoryFullName}
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
        <div className="flex flex-col gap-2 border-b px-4 py-3">
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

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {pullRequest.merged ? (
              <span className="inline-flex w-fit items-center rounded-full bg-purple-600/15 px-2 py-0.5 text-xs font-medium text-purple-700 ring-1 ring-inset ring-purple-600 dark:text-purple-400">
                マージ済み
              </span>
            ) : pullRequest.state === "closed" ? (
              <span className="inline-flex w-fit items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
                クローズ済み
              </span>
            ) : pullRequest.draft ? (
              <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>
            ) : (
              <CiStateBadge ciState={pullRequest.ciState} />
            )}
            <DeployStatusBadge status={deployStatus} />
            {pullRequest.autoMergeEnabled && (
              <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>
            )}
            {requiresUserMerge(pullRequest) && <UserMergeRequiredBadge />}
            <ConflictBadge mergeable={pullRequest.mergeable} />

            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <UserAvatar login={pullRequest.authorLogin} className="size-4" />
              {pullRequest.authorLogin}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatElapsed(pullRequest.createdAt)}
            </span>
            <PullRequestRepairButtons
              repositoryFullName={pullRequest.repositoryFullName}
              pullRequestNumber={pullRequest.number}
              kinds={repairKinds}
            />
            {canMergeFromDeck(pullRequest) && (
              <PullRequestMergeButton
                pullRequest={pullRequest}
                onMerged={onMerged}
                variant="default"
                className="ml-auto"
              />
            )}
          </div>

          {currentDetail && (
            <p className="text-xs text-muted-foreground">
              <span className="text-green-600">+{currentDetail.additions}</span>{" "}
              <span className="text-destructive">-{currentDetail.deletions}</span>
              {` ・ ${currentDetail.changedFiles}ファイル ・ ${currentDetail.commits}コミット`}
            </p>
          )}
        </div>

        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

        {!error && !currentDetail && isLoading && (
          <div className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {currentDetail && (
          <>
            <section className="border-b px-4 py-3">
              {currentDetail.body.trim() ? (
                <MarkdownBody
                  content={currentDetail.body}
                  repositoryFullName={pullRequest.repositoryFullName}
                />
              ) : (
                <p className="text-sm text-muted-foreground">本文はありません。</p>
              )}
            </section>

            <section>
              <h2 className="border-b bg-muted/50 px-4 py-2 text-xs font-semibold">
                コメント {currentDetail.events.length}件
              </h2>
              {currentDetail.events.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  コメントはまだありません。
                </p>
              ) : (
                <ul>
                  {currentDetail.events.map((event) => (
                    <EventItem
                      key={event.id}
                      event={event}
                      repositoryFullName={pullRequest.repositoryFullName}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
