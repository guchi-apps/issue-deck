"use client";

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

import type { CiState } from "@/lib/github/release-api";
import { cn } from "@/lib/utils";
import type { PullRequestKind, PullRequestSummary } from "@/types/pull-request";

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

/** 種別のラベル。`other`（規約から外れたPR）はラベルを出さないためnull */
export function pullRequestKindLabel(kind: PullRequestKind): string | null {
  return kind === "other" ? null : KIND_LABEL[kind];
}

export function formatElapsed(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "1時間以内";
  if (diffHours < 24) return `${diffHours}時間前`;
  return `${Math.floor(diffHours / 24)}日前`;
}

/** CI状態のピル。配色は`release-progress.tsx`のCiStateBadgeに揃えている */
export function CiStateBadge({ ciState }: { ciState: CiState }) {
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

export function BranchBadge({ baseRef, headRef }: { baseRef: string; headRef: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <code className="truncate rounded bg-muted px-1 py-0.5">{headRef}</code>
      <span aria-hidden="true">→</span>
      <code className="truncate rounded bg-muted px-1 py-0.5">{baseRef}</code>
    </span>
  );
}

/**
 * PRの状態アイコン。マージ待ち一覧はopenのPRしか並ばないが、画面内のリンクから開いたPRは
 * マージ済み・クローズ済みでもありうるため、4状態を区別する（#1260）。
 */
export function PullRequestStateIcon({
  pullRequest,
  className,
}: {
  pullRequest: Pick<PullRequestSummary, "state" | "merged" | "draft">;
  className?: string;
}) {
  if (pullRequest.merged) {
    return <GitMerge className={cn("text-purple-600", className)} aria-label="マージ済み" />;
  }
  if (pullRequest.state === "closed") {
    return (
      <GitPullRequestClosed className={cn("text-destructive", className)} aria-label="クローズ済み" />
    );
  }
  if (pullRequest.draft) {
    return <GitPullRequestDraft className={cn("text-muted-foreground", className)} aria-label="ドラフト" />;
  }
  return <GitPullRequest className={cn("text-green-600", className)} aria-label="オープン" />;
}

/**
 * 自動ではマージされないPRに出す注意書き（#1469）。判定は`requiresUserMerge`だけを通す。
 *
 * 配色のamberは、このアプリで「ユーザーの確認待ち」（`00.check-user`）に使っている色に揃えている
 * （`manual-step-panel.tsx`のコメント・`issue-pull-request-list.tsx`）。CI状態やAuto-mergeの
 * バッジと同じ灰色にすると、待っていれば片付く状態と区別が付かない。
 */
export function UserMergeRequiredBadge() {
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
      ユーザーのマージが必要です
    </span>
  );
}

/** 一覧・詳細で共通の補助バッジ（ドラフト・Auto-merge有効） */
export function PullRequestMetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}
