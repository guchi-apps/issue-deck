"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { ExternalLink, GitPullRequest, GitPullRequestDraft, Lock, RefreshCw } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import type { CiState } from "@/lib/github/release-api";
import { groupPullRequestsByRepository, needsManualMerge } from "@/lib/pull-request-list";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { OpenPullRequest, PullRequestKind } from "@/types/pull-request";

type PullRequestListProps = {
  pullRequests: OpenPullRequest[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる（#677と同じ理由） */
  footerSpacing?: boolean;
};

const CI_STATE_LABEL: Record<CiState, string> = {
  pending: "CI実行中",
  success: "CI通過",
  failure: "CI失敗",
  unknown: "CI状態は不明",
};

const KIND_LABEL: Record<Exclude<PullRequestKind, "other">, string> = {
  release: "リリース（develop→main）",
  "version-bump": "バージョンバンプ",
  issue: "Issue対応",
};

function formatElapsed(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "1時間以内";
  if (diffHours < 24) return `${diffHours}時間前`;
  return `${Math.floor(diffHours / 24)}日前`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** CI状態のピル。配色は`release-progress.tsx`のCiStateBadgeに揃えている */
function CiStateBadge({ ciState }: { ciState: CiState }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        ciState === "pending"
          ? "bg-primary/15 text-primary ring-primary"
          : ciState === "failure"
            ? "bg-destructive/15 text-destructive ring-destructive"
            : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {CI_STATE_LABEL[ciState]}
    </span>
  );
}

function BranchBadge({ baseRef, headRef }: { baseRef: string; headRef: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <code className="truncate rounded bg-muted px-1 py-0.5">{headRef}</code>
      <span aria-hidden="true">→</span>
      <code className="truncate rounded bg-muted px-1 py-0.5">{baseRef}</code>
    </span>
  );
}

function PullRequestCard({
  pullRequest,
  onMerged,
}: {
  pullRequest: OpenPullRequest;
  onMerged: () => void;
}) {
  const { mergePullRequest, isSubmitting, error } = usePullRequestMergeMutation();
  const [owner, repo] = pullRequest.repositoryFullName.split("/");
  const kindLabel = pullRequest.kind === "other" ? null : KIND_LABEL[pullRequest.kind];

  async function handleMerge() {
    const merged = await mergePullRequest({ owner, repo, number: pullRequest.number });
    if (merged) onMerged();
  }

  return (
    <li className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
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
            行末に番号を置くとタイトルが長いときに見切れて、PRの識別子が読めなくなるため。 */}
        <a
          href={pullRequest.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 text-sm font-medium hover:underline"
        >
          #{pullRequest.number} {pullRequest.title}
          <ExternalLink className="ml-1 inline size-3 text-muted-foreground" />
        </a>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <BranchBadge baseRef={pullRequest.baseRef} headRef={pullRequest.headRef} />
        {kindLabel && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {kindLabel}
          </span>
        )}
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
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            ドラフト
          </span>
        ) : (
          <CiStateBadge ciState={pullRequest.ciState} />
        )}
        {pullRequest.autoMergeEnabled && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            Auto-merge有効
          </span>
        )}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <UserAvatar login={pullRequest.authorLogin} className="size-4" />
          {pullRequest.authorLogin}
        </span>
        <span className="text-xs text-muted-foreground">{formatElapsed(pullRequest.createdAt)}</span>
        {needsManualMerge(pullRequest) && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7"
            disabled={isSubmitting}
            onClick={handleMerge}
          >
            {isSubmitting ? "マージ中..." : "マージする"}
          </Button>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
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
  headerLeading,
  className,
  style,
  footerSpacing = false,
}: PullRequestListProps) {
  // マージ直後はGitHub側の反映を待たずに一覧から消したいが、再取得の結果が返るまでの間だけ
  // ローカルに伏せる（次の取得結果で正しい状態に置き換わる）。
  const [mergedIds, setMergedIds] = useState<string[]>([]);
  const visiblePullRequests = pullRequests.filter((pr) => !mergedIds.includes(pr.id));
  const groups = groupPullRequestsByRepository(visiblePullRequests);

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        {headerLeading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">マージ待ちPR</h1>
          <p className="truncate text-xs text-muted-foreground">
            <span>{visiblePullRequests.length}件</span>
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

        {!error && visiblePullRequests.length === 0 && (
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
                  onMerged={() => {
                    setMergedIds((prev) => [...prev, pullRequest.id]);
                    onRefresh();
                  }}
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
