"use client";

import {
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Rocket,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import type { MergeJudgement } from "@/lib/github/check-rollup";
import type { CiState } from "@/lib/github/release-api";
import { mergeJudgementLabel, mergeJudgementReason } from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type {
  PullRequestDeployStatus,
  PullRequestDeployStatusKind,
  PullRequestKind,
  PullRequestSummary,
} from "@/types/pull-request";

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

/**
 * コンフリクトのピル（#1742）。`mergeable`が`false`のときだけ描く。
 *
 * **`null`（GitHubが判定中・未取得）では何も出さない。** 判定前を「コンフリクトなし」とも
 * 「あり」とも言わない方針で、自動解消ボタンの出し分け（`repairKindsFor`）と揃えている。
 * PR一覧・PR詳細・確認待ち一覧・リリース進捗のどこでも同じ見た目にするためここに置く。
 */
export function ConflictBadge({ mergeable }: { mergeable: boolean | null | undefined }) {
  if (mergeable !== false) return null;
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
      コンフリクトあり
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
 * 自動マージ可否の判定が終わっていないPRに出すピル（#2059）。`pending`のときだけ描く。
 *
 * **マージボタンの「判定中」が何を待っているのかを、画面に出すためにある。** 理由の文言は
 * #1968からあったが置き場所がボタンの`title`属性だけで、スマホではツールチップが出ないため
 * 読む手段が無かった。CI状態とは別の軸なので（#1799でCI集約から外している）、CI状態のピルの
 * 隣に別のピルとして並べる——「CI通過」と「判定中」が同時に出るのは矛盾ではなく、CIが終わった
 * 後にレビューと判定だけが動いている窓（実測で約3分）を指している。
 *
 * `runUrl`があればピルごとそのジョブの実行ログへのリンクにする（進み具合を見に行けるように）。
 * 配色はCI実行中と同じprimaryで「待てば片付く」ことを表し、回転アイコンで見分けを付ける。
 */
export function MergeJudgementBadge({ mergeJudgement }: { mergeJudgement: MergeJudgement }) {
  if (mergeJudgement.state !== "pending") return null;

  const label = mergeJudgementLabel(mergeJudgement.step);
  const reason = mergeJudgementReason(mergeJudgement.step);
  const className =
    "inline-flex w-fit items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary";
  const content = (
    <>
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      {label}
    </>
  );

  if (mergeJudgement.runUrl === null) {
    return (
      <span className={className} title={reason}>
        {content}
      </span>
    );
  }
  return (
    <a
      href={mergeJudgement.runUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, "hover:underline")}
      title={`${reason}（クリックで実行ログを開きます）`}
    >
      {content}
    </a>
  );
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

const DEPLOY_STATUS_LABEL: Record<PullRequestDeployStatusKind, string> = {
  "develop-only": "本番未反映（developまで）",
  waiting: "デプロイ待ち",
  running: "本番へデプロイ中",
  deployed: "本番反映済み",
  failed: "デプロイ失敗",
};

const DEPLOY_STATUS_CLASS: Record<PullRequestDeployStatusKind, string> = {
  "develop-only": "bg-muted text-muted-foreground ring-border",
  waiting: "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
  running: "bg-primary/15 text-primary ring-primary",
  deployed: "bg-green-600/15 text-green-700 ring-green-600 dark:text-green-400",
  failed: "bg-destructive/15 text-destructive ring-destructive",
};

const DEPLOY_STATUS_ICON: Record<PullRequestDeployStatusKind, LucideIcon> = {
  "develop-only": GitMerge,
  waiting: Clock,
  running: Loader2,
  deployed: Rocket,
  failed: TriangleAlert,
};

/**
 * このPRが本番へ届いたかを表すピル（#1814）。判定は`resolvePullRequestDeployStatus`だけを通す。
 *
 * **`status`がnull（判定できない）なら何も出さない。** 未マージのPR・`deploy.yml`が無い
 * リポジトリ・取得した範囲より古いPRで「未反映」と言い切らないため（ブランチ画面と同じ方針。#1579）。
 * デプロイ実行が分かっている状態ではピルごと実行ログへのリンクにする。
 */
export function DeployStatusBadge({ status }: { status: PullRequestDeployStatus | null }) {
  if (status === null) return null;

  const Icon = DEPLOY_STATUS_ICON[status.kind];
  const label = status.version
    ? `${DEPLOY_STATUS_LABEL[status.kind]} v${status.version}`
    : DEPLOY_STATUS_LABEL[status.kind];
  const className = cn(
    "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
    DEPLOY_STATUS_CLASS[status.kind],
  );
  const icon = (
    <Icon className={cn("size-3", status.kind === "running" && "animate-spin")} aria-hidden="true" />
  );

  if (status.deployRunUrl === null) {
    return (
      <span className={className}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <a
      href={status.deployRunUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, "hover:underline")}
      title="デプロイの実行ログを開く"
    >
      {icon}
      {label}
    </a>
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
