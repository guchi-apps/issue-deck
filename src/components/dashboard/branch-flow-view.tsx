"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Clock,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  CiStateBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  UserMergeRequiredBadge,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { RepositoryReleaseButton } from "@/components/dashboard/repository-release-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  autoRefreshIntervalLabel,
  type AutoRefreshIntervalMs,
} from "@/lib/auto-refresh";
import { useReleaseTriggerPending } from "@/hooks/use-release-trigger-pending";
import {
  DEVELOP_BRANCH,
  MAIN_BRANCH,
  isClosedLane,
  isReleaseCiPending,
  type BranchFlow,
} from "@/lib/branch-flow";
import { getProgressStatusDef } from "@/lib/issue-progress";
import { canMergeFromDeck, requiresUserMerge } from "@/lib/pull-request-list";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type {
  BranchFlowDeployState,
  BranchFlowDeployStateKind,
  BranchFlowIssuePriority,
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowManualStep,
  BranchFlowPlannedIssue,
  BranchFlowReleaseGroup,
  BranchFlowRepository,
} from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

type BranchFlowViewProps = {
  flow: BranchFlow;
  fetchedAt: string | null;
  isLoading: boolean;
  /**
   * 自動更新も含めて取得が飛んでいるか（#1767）。更新アイコンの回転にだけ使い、
   * ボタンの無効化・「読み込み中...」には使わない（自動更新のたびに操作できなくなるため）。
   * 渡されない場合は`isLoading`と同じ扱い。
   */
  isRefreshing?: boolean;
  error: string | null;
  /** ブランチ状況を取得できなかったリポジトリ（PRだけで組み立てている） */
  failedRepositories: string[];
  /**
   * マージ済み（クローズ済み）のPRまで取得できているか（#1711）。
   *
   * **この画面のリリースの束は、クローズ済みのPRが揃って初めて組み立てられる。** PR一覧の母集団は
   * この画面を開いたときに`open`から`all`へ広がる（`hooks/use-pull-requests.ts`）ため、広がる前の
   * 一瞬は「マージ済みのPRが1件も無い」状態を描くことになる。本番デプロイの直後は進行中の作業も
   * 無いため、その一瞬が「何も無い・リリース済みを開くボタンも無い」画面として現れていた
   * （PWAはデプロイを検知して自動でリロードするため、ちょうどこの画面が出ている時間と重なる）。
   */
  mergedPullRequestsLoaded: boolean;
  /**
   * 開いた状態で見せるリポジトリ（#1750）。PCの左メニューで選択中のリポジトリを渡す。
   *
   * **この画面はリポジトリ絞り込みを適用しない**（横断で流れを俯瞰する場所のため）ので、
   * 選択は「絞る」ではなく「先頭へ寄せて展開する」形で効かせる。並べ替えは
   * `orderRepositoriesBySelection`が済ませてあり、ここは開閉だけを扱う。
   * スマホにはリポジトリ絞り込みが無いため渡さない。
   */
  expandedRepositoryFullNames?: readonly string[];
  /**
   * 自動更新の間隔（#1767）。`null`＝自動更新しない。**画面に出す間隔もこの値で、
   * 「有効かどうか」を別に持たない**——別々に持つと表示と実際の間隔がずれうる。
   */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
  /** 自動更新の間隔をメニューから変えたとき（#1767）。渡さない場合はメニューを出さない */
  onChangeAutoRefreshInterval?: (intervalMs: AutoRefreshIntervalMs) => void;
  onRefresh: () => void;
  /**
   * この画面からPRをマージできたとき（#1756）。**再取得より先にマージ済みとして描くのは
   * 親の仕事**で、それが同じPRを二度マージできないことの根拠になっている
   * （`lib/pull-request-list.ts`の`applyOptimisticMerges`）。
   *
   * 渡されない場合は`onRefresh`だけを呼ぶ（＝再取得が返るまでマージ待ちのまま残る）。
   */
  onMerged?: (pullRequest: PullRequestSummary) => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  /** 見出しの右に置くボタン（スマホの実行状況。#1638。PCからは渡さない） */
  headerActions?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる */
  footerSpacing?: boolean;
};

/**
 * まだどのバージョンにも乗っていないレーンの状態（#1510）。
 *
 * マージ済みのレーンにはバッジを出さない——**どのリリースの横線の下にいるか**が
 * 「developへマージ済み」「main未反映」「vX.Y.Zで本番反映」をまとめて表すため。
 */
const LANE_STATUS_LABEL: Partial<Record<BranchFlowLaneStatus, string>> = {
  "no-pull-request": "PR未作成",
  open: "マージ待ち",
  closed: "クローズ（未マージ）",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

/** レーンの状態を表すピル。マージ待ちだけ色を付ける */
function LaneStatusBadge({ status }: { status: BranchFlowLaneStatus }) {
  const label = LANE_STATUS_LABEL[status];
  if (!label) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
        status === "open"
          ? "bg-primary/15 text-primary ring-primary"
          : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {label}
    </span>
  );
}

/**
 * 本番デプロイの状態を表すピル（#1579）。
 *
 * **mainへマージしただけでは本番に出ていない。** リリースの束の見出しでは長い方の文言
 * （「本番へデプロイ中」）、畳んだ1行では短い方（「デプロイ中」）を使う。
 */
const DEPLOY_STATE_LABEL: Record<BranchFlowDeployStateKind, string> = {
  waiting: "デプロイ待ち",
  running: "本番へデプロイ中",
  success: "デプロイ成功",
  failure: "デプロイ失敗",
};

const DEPLOY_STATE_LABEL_COMPACT: Record<BranchFlowDeployStateKind, string> = {
  waiting: "デプロイ待ち",
  running: "デプロイ中",
  success: "デプロイ成功",
  failure: "デプロイ失敗",
};

/** 配色はリリースの横線（purple）・失敗（destructive）・成功（green）に合わせる */
const DEPLOY_STATE_CLASS: Record<BranchFlowDeployStateKind, string> = {
  waiting: "bg-muted text-muted-foreground ring-border",
  running: "bg-purple-500/15 text-purple-700 ring-purple-500 dark:text-purple-300",
  success:
    "bg-green-500/10 text-green-700 ring-green-600/50 dark:text-green-400 dark:ring-green-500/50",
  failure: "bg-destructive/15 font-medium text-destructive ring-destructive",
};

function DeployStateIcon({ kind }: { kind: BranchFlowDeployStateKind }) {
  switch (kind) {
    case "running":
      return <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />;
    case "success":
      return <Check className="size-3 shrink-0" aria-hidden="true" />;
    case "failure":
      return <CircleAlert className="size-3 shrink-0" aria-hidden="true" />;
    default:
      return <Clock className="size-3 shrink-0" aria-hidden="true" />;
  }
}

function DeployStateBadge({
  deploy,
  compact = false,
  linkToRun = true,
}: {
  deploy: BranchFlowDeployState | null;
  /** 畳んだ1行向けの短い文言にする */
  compact?: boolean;
  /**
   * 実行ログへのリンクにするか。**畳んだ1行はそれ自体が`<button>`なので必ずfalseにする**
   * （ボタンの中にリンクを入れられない）。
   */
  linkToRun?: boolean;
}) {
  if (!deploy) return null;

  const label = (compact ? DEPLOY_STATE_LABEL_COMPACT : DEPLOY_STATE_LABEL)[deploy.kind];
  const content = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
        DEPLOY_STATE_CLASS[deploy.kind],
      )}
    >
      <DeployStateIcon kind={deploy.kind} />
      {label}
    </span>
  );

  // 実行ログはアプリ内に対応する画面が無いので別タブで開く（`release-progress.tsx`と同じ）
  return deploy.htmlUrl && linkToRun ? (
    <a
      href={deploy.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 hover:underline"
      title="GitHub Actionsで実行ログを開く"
    >
      {content}
    </a>
  ) : (
    content
  );
}

function IssueLine({
  repositoryFullName,
  issue,
  /** 同じレーンのPRのタイトル。一致するときはタイトルを繰り返さない（#1510） */
  pullRequestTitle,
}: {
  repositoryFullName: string;
  issue: BranchFlowIssueRef;
  pullRequestTitle?: string;
}) {
  const sameTitle = issue.title !== null && issue.title === pullRequestTitle;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <GithubReferenceLink
        href={`https://github.com/${repositoryFullName}/issues/${issue.number}`}
        reference={{ repositoryFullName, number: issue.number, kind: "issue" }}
        className="min-w-0 max-w-full break-words text-xs text-primary hover:underline"
      >
        Issue #{issue.number}
        {issue.title && !sameTitle ? ` ${issue.title}` : ""}
      </GithubReferenceLink>
      {sameTitle && <span className="text-xs text-muted-foreground">（PRと同じ題）</span>}
      {issue.progress && (
        <PullRequestMetaBadge>{getProgressStatusDef(issue.progress).label}</PullRequestMetaBadge>
      )}
      {issue.state === null && <span className="text-xs text-muted-foreground">一覧に無い</span>}
      {issue.state === "closed" && <span className="text-xs text-muted-foreground">クローズ済み</span>}
    </div>
  );
}

/**
 * 1本のPRが複数のIssueを扱っている場合の2件目以降（#1455）。
 *
 * **タイトルを出せないもの（DBキャッシュに無い）は番号だけを1行へまとめる**（#1510）。
 * 本文の`#番号`は単なる言及も混ざり、中身が分からないまま1件1行を占めていたため。
 */
function RelatedIssuesLine({
  repositoryFullName,
  issues,
}: {
  repositoryFullName: string;
  issues: BranchFlowIssueRef[];
}) {
  if (issues.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="shrink-0 text-xs text-muted-foreground">関連</span>
      {issues.map((issue) => (
        <GithubReferenceLink
          key={issue.number}
          href={`https://github.com/${repositoryFullName}/issues/${issue.number}`}
          reference={{ repositoryFullName, number: issue.number, kind: "issue" }}
          className="min-w-0 max-w-full break-words text-xs text-primary hover:underline"
        >
          #{issue.number}
          {issue.title ? ` ${issue.title}` : ""}
        </GithubReferenceLink>
      ))}
    </div>
  );
}

/**
 * このレーンから残った手作業Issue（#1510）。
 *
 * 未完了のamberは`00.check-user`と同じ「人の操作を待っている」色に揃えている
 * （`pull-request-badges.tsx`の`UserMergeRequiredBadge`と同じ理由）。
 */
function ManualStepLine({
  repositoryFullName,
  manualStep,
  /** 起点のブランチ名。レーンから離して出すとき（#1586）だけ添える */
  branchName,
}: {
  repositoryFullName: string;
  manualStep: BranchFlowManualStep;
  branchName?: string;
}) {
  const isOpen = manualStep.state === "open";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Wrench
        className={cn("size-3 shrink-0", isOpen ? "text-amber-600" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <GithubReferenceLink
        href={`https://github.com/${repositoryFullName}/issues/${manualStep.number}`}
        reference={{ repositoryFullName, number: manualStep.number, kind: "issue" }}
        className={cn(
          "min-w-0 max-w-full break-words text-xs hover:underline",
          isOpen ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        手作業 #{manualStep.number} {manualStep.title}
      </GithubReferenceLink>
      <span className="shrink-0 text-xs text-muted-foreground">{isOpen ? "未完了" : "完了"}</span>
      {branchName && (
        <>
          <span className="shrink-0 text-xs text-muted-foreground">起点</span>
          <code className="min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {branchName}
          </code>
        </>
      )}
    </div>
  );
}

/**
 * 畳んだ束に残っている未完了の手作業（#1586）。
 *
 * 既定の表示を「次のリリースに乗る分」までに絞ったことで、本番へ出た版に紐づく手作業も
 * 一緒に隠れる。**手作業は版が出た後も残る作業**なので、束の外へ出して常に見せる。
 * 完了済みは残作業ではないため、畳んだ束と一緒に隠したままにする。
 */
function RemainingManualSteps({
  repositoryFullName,
  manualSteps,
}: {
  repositoryFullName: string;
  manualSteps: { manualStep: BranchFlowManualStep; branchName: string }[];
}) {
  return (
    <div className="mt-3 rounded-md border border-dashed border-amber-500/60 bg-amber-500/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Wrench className="size-3.5" aria-hidden="true" />
        リリース済みの変更に残っている手作業
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {manualSteps.map(({ manualStep, branchName }) => (
          <li key={manualStep.number}>
            <ManualStepLine
              repositoryFullName={repositoryFullName}
              manualStep={manualStep}
              branchName={branchName}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * レーンにぶら下がるPR1行。
 *
 * **マージボタンを出すのは「ユーザーがマージするしかないPR」だけ**（#1756）。この画面は
 * 手が要るものを探すための画面で、畳んだ行にも「ユーザーのマージが必要」を出しているのに、
 * 開いた先に押せるものが無かった。待てば自動で入るPR（Auto-merge有効・レビュー統合エージェントが
 * 自動マージするもの）に出すと、押す必要が無いものまで押させることになるため、
 * 条件はPR一覧と同じ`requiresUserMerge`・`canMergeFromDeck`をそのまま使う
 * （すぐ下の`BumpPullRequestLine`も同じ方針）。
 */
function PullRequestLine({
  pullRequest,
  onMerged,
}: {
  pullRequest: PullRequestSummary;
  /**
   * マージできたとき。**渡さない行にはマージの導線（バッジもボタンも）を出さない。**
   * リリースの束の見出しはPRの行とは別にマージボタンを持っているため（`ReleaseMergeButton`）、
   * その下に並べるPRの行へ渡すと同じPRのボタンが2つ出る。
   */
  onMerged?: (pullRequest: PullRequestSummary) => void;
}) {
  const kindLabel = pullRequestKindLabel(pullRequest.kind);
  const userMerge = onMerged !== undefined && requiresUserMerge(pullRequest);
  const canMerge = userMerge && canMergeFromDeck(pullRequest);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <PullRequestStateIcon pullRequest={pullRequest} className="size-3.5 shrink-0" />
      <GithubReferenceLink
        href={pullRequest.htmlUrl}
        reference={{
          repositoryFullName: pullRequest.repositoryFullName,
          number: pullRequest.number,
          kind: "pull",
        }}
        className="min-w-0 max-w-full break-words text-xs font-medium hover:underline"
      >
        #{pullRequest.number} {pullRequest.title}
      </GithubReferenceLink>
      {pullRequest.draft ? (
        <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>
      ) : (
        pullRequest.state === "open" && <CiStateBadge ciState={pullRequest.ciState} />
      )}
      {pullRequest.autoMergeEnabled && <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>}
      {/* 種類は「今どうなっているか」ではないので、状態のピルと同じ強さで出さない（#1510） */}
      {kindLabel && pullRequest.kind !== "issue" && (
        <span className="shrink-0 text-xs text-muted-foreground">{kindLabel}</span>
      )}
      {/* ボタンだけを置くと「なぜ自動で入らないのか」が分からないので、理由のバッジも添える。
          コンフリクト等でボタンを出せない場合もバッジは出す——押せないこととは別の事実 */}
      {userMerge && <UserMergeRequiredBadge />}
      {canMerge && (
        <PullRequestMergeButton
          pullRequest={pullRequest}
          onMerged={() => onMerged?.(pullRequest)}
          className="shrink-0"
          variant="outline"
        />
      )}
    </div>
  );
}

/**
 * 流れ図の1行。`develop`のレールから右へ出る枝として描く（#1510）。
 *
 * developへ入っているレーンは塗りつぶしの点、まだ入っていないレーンは破線の枝と
 * 中抜きの点にして、「戻ってきたかどうか」を形で見せる。
 */
function LaneRow({
  repositoryFullName,
  lane,
  onMerged,
}: {
  repositoryFullName: string;
  lane: BranchFlowLane;
  /** レーンのPRをこの画面からマージできたとき（#1756） */
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  const merged = lane.status === "merged";
  const headPullRequest = lane.pullRequests[0] ?? null;

  return (
    <li className="relative py-1 pl-[3.35rem] max-sm:pl-[2.6rem]">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[0.85rem] left-[2.25rem] w-[0.85rem] max-sm:left-[1.75rem] max-sm:w-[0.7rem]",
          merged ? "border-t border-border" : "border-t border-dashed border-border",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[0.6rem] left-[calc(2.25rem-3px)] size-[7px] rounded-full max-sm:left-[calc(1.75rem-3px)]",
          merged ? "bg-primary" : "border-[1.5px] border-primary bg-background",
        )}
      />

      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <code className="min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {lane.branchName}
          </code>
          <LaneStatusBadge status={lane.status} />
        </div>

        {lane.pullRequests.map((pullRequest) => (
          <PullRequestLine key={pullRequest.id} pullRequest={pullRequest} onMerged={onMerged} />
        ))}

        {lane.issue ? (
          <IssueLine
            repositoryFullName={repositoryFullName}
            issue={lane.issue}
            pullRequestTitle={headPullRequest?.title}
          />
        ) : (
          <span className="text-xs text-muted-foreground">対応Issue不明</span>
        )}
        <RelatedIssuesLine
          repositoryFullName={repositoryFullName}
          issues={lane.relatedIssues}
        />
        {lane.manualSteps.map((manualStep) => (
          <ManualStepLine
            key={manualStep.number}
            repositoryFullName={repositoryFullName}
            manualStep={manualStep}
          />
        ))}
      </div>
    </li>
  );
}

/**
 * リリース待ちのPRをこの画面からマージするボタン（#1548）。
 *
 * マージ操作そのものは一覧・詳細と同じ`PullRequestMergeButton`に任せる。**mainへのPRは
 * `mergeWarnings`が本番デプロイの警告を必ず返すため、押すと確認ダイアログを通る。**
 */
function ReleaseMergeButton({
  pullRequest,
  onMerged,
}: {
  pullRequest: PullRequestSummary;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  return (
    <PullRequestMergeButton
      pullRequest={pullRequest}
      onMerged={() => onMerged(pullRequest)}
      className="shrink-0"
      variant="outline"
    />
  );
}

/**
 * 未リリースの束に乗っているバージョンバンプPR（`release/vX.Y.Z`→develop。#1548）。
 *
 * **作業レーンとしては描かない。** バンプPRの本文には今回のリリース対象issueが並ぶため、
 * レーンとして扱うと無関係なIssueがそのレーンの「対応Issue」「関連」としてぶら下がる。
 * ここでは幹の一部として、版・PR・CI状態・待っているマージ先だけを1行で出す。
 *
 * マージボタンは**Auto-mergeが効いていないとき（＝滞留しているとき）だけ**出す。
 * 待てば入るものにボタンを出すと、押す必要がないものまで押させることになる。
 */
function BumpPullRequestLine({
  pullRequest,
  version,
  onMerged,
}: {
  pullRequest: PullRequestSummary;
  version: string | null;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-purple-500/60 bg-purple-500/5 px-2 py-1.5">
      <span className="shrink-0 text-xs font-medium text-purple-700 dark:text-purple-300">
        バージョンバンプ{version ? ` v${version}` : ""}
      </span>
      <PullRequestStateIcon pullRequest={pullRequest} className="size-3.5 shrink-0" />
      <GithubReferenceLink
        href={pullRequest.htmlUrl}
        reference={{
          repositoryFullName: pullRequest.repositoryFullName,
          number: pullRequest.number,
          kind: "pull",
        }}
        className="min-w-0 max-w-full break-words text-xs hover:underline"
      >
        #{pullRequest.number} {pullRequest.title}
      </GithubReferenceLink>
      {pullRequest.state === "open" && <CiStateBadge ciState={pullRequest.ciState} />}
      {pullRequest.autoMergeEnabled ? (
        <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">developへマージ待ち</span>
      )}
      {!pullRequest.autoMergeEnabled && (
        <ReleaseMergeButton pullRequest={pullRequest} onMerged={onMerged} />
      )}
    </div>
  );
}

/**
 * 実装予定として既定で出す件数（#1704）。
 *
 * **未着手はバックログ全体なので、全部出すと流れ図が下へ押し出される。** 頭出しだけを既定にし、
 * 残りはリポジトリごとのボタンで開く（件数そのものは見出しに出ているので、隠れていることは分かる）。
 */
const PLANNED_ISSUE_PREVIEW_COUNT = 3;

/** 優先度のピル。高だけ色を付ける（低は「後回しでよい」という情報なので目立たせない） */
function IssuePriorityBadge({ priority }: { priority: BranchFlowIssuePriority }) {
  if (priority === "low") return <PullRequestMetaBadge>優先度 低</PullRequestMetaBadge>;
  return (
    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
      優先度 高
    </span>
  );
}

/**
 * まだブランチが無い「実装予定」のIssue（#1704）。
 *
 * 流れ図のいちばん上、作業レーンより上流に置く。**枝も点も破線にして「まだブランチになっていない」
 * ことを形で出す**——実線の枝（＝実在するブランチ）と同じ描き方にすると、ブランチが切られたものと
 * 見分けが付かない。
 *
 * 既定は`PLANNED_ISSUE_PREVIEW_COUNT`件までで、残りはボタンで開く。**0件のときは見出しごと出さない**
 * （何も無いことを毎行に書かない）。
 */
function PlannedIssues({
  repositoryFullName,
  issues,
  showAll,
  onToggleShowAll,
}: {
  repositoryFullName: string;
  issues: BranchFlowPlannedIssue[];
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  if (issues.length === 0) return null;

  const visible = showAll ? issues : issues.slice(0, PLANNED_ISSUE_PREVIEW_COUNT);
  const hiddenCount = issues.length - visible.length;

  return (
    <>
      <li className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-0.5 pl-[3.35rem] max-sm:pl-[2.6rem]">
        <span className="text-xs font-medium text-muted-foreground">実装予定 {issues.length}件</span>
        <span className="text-xs text-muted-foreground">まだブランチが無いIssue</span>
      </li>

      {visible.map((issue) => (
        <li key={issue.number} className="relative py-1 pl-[3.35rem] max-sm:pl-[2.6rem]">
          <span
            aria-hidden="true"
            className="absolute top-[0.85rem] left-[2.25rem] w-[0.85rem] border-t border-dashed border-muted-foreground/50 max-sm:left-[1.75rem] max-sm:w-[0.7rem]"
          />
          <span
            aria-hidden="true"
            className="absolute top-[0.6rem] left-[calc(2.25rem-3px)] size-[7px] rounded-full border-[1.5px] border-dashed border-muted-foreground/60 bg-background max-sm:left-[calc(1.75rem-3px)]"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <IssueLine repositoryFullName={repositoryFullName} issue={issue} />
            {issue.priority && <IssuePriorityBadge priority={issue.priority} />}
          </div>
        </li>
      ))}

      {(hiddenCount > 0 || showAll) && (
        <li className="pt-1 pb-0.5 pl-[3.35rem] max-sm:pl-[2.6rem]">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={onToggleShowAll}
          >
            {hiddenCount > 0
              ? `実装予定の残り${hiddenCount}件を表示`
              : `実装予定を${PLANNED_ISSUE_PREVIEW_COUNT}件だけ表示`}
          </Button>
        </li>
      )}
    </>
  );
}

/**
 * リリースが進行中であることを表す紫のピル（#1931）。畳んだ1行と束の見出しで同じものを使う。
 *
 * **自動で進んでいる間だけ回るアイコンを添える。** 自動で進んでいる状態と、CIが終わって人の
 * マージを待っている状態が同じ見た目だったため、開くまで区別できなかった。アイコンは
 * 「デプロイ中」（`DeployStateIcon`）とまったく同じ形・大きさにして、同じ画面で2種類の
 * 回り方が混ざらないようにしている。文言は変えず、読み上げにだけ実行中であることを足す。
 *
 * 回っている理由は状態によって違う（CI実行中／workflowの起動待ち。#1955）ので、読み上げへ
 * 足す言葉は呼び出し側から渡す。
 */
function ReleaseProgressPill({
  label,
  spinning,
  note,
}: {
  label: string;
  /** 自動で進んでいる最中か。trueのときだけ回るアイコンを出す */
  spinning: boolean;
  /** 回っている理由。読み上げに`${label}（${note}）`の形で足す */
  note?: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-xs text-purple-700 ring-1 ring-inset ring-purple-500 dark:text-purple-300"
      aria-label={spinning && note ? `${label}（${note}）` : undefined}
    >
      {spinning && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
      {label}
    </span>
  );
}

/**
 * リリース1回ぶんの横線（#1510）。`main`のレールと`develop`のレールを結ぶ。
 *
 * **この線より下にぶら下がっているレーンが、そのバージョンに乗った変更。** 本番へ出た版は
 * 実線とひし形、まだ出ていない版は破線と中抜きのひし形で描く。
 *
 * 未リリースの束には、バージョンバンプPR（幹の一部）とmainへのマージ導線も置く（#1548）。
 */
function ReleaseGroupHeader({
  group,
  releaseButton,
  onMerged,
}: {
  group: BranchFlowReleaseGroup;
  releaseButton?: React.ReactNode;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  const released = group.mergedAt !== null;
  // **「本番反映」と言い切ってよいのは、デプロイまで済んだときだけ**（#1579）。
  // デプロイの状態が分からない（`deploy`がnull）場合は、従来どおりの文言に戻す。
  const inProduction = group.deploy === null || group.deploy.kind === "success";
  // **CIが実行中の間は「マージ待ち」と言わない**（#1433と同じ基準）。まだマージできない操作を
  // 人へ促すことになるため、そのあいだは自動で進む「リリース中」のままにする。
  const waitingUserMerge =
    group.pullRequest !== null &&
    group.pullRequest.state === "open" &&
    group.pullRequest.ciState !== "pending";

  return (
    <li className="relative pt-3 pb-1 pl-[3.35rem] max-sm:pl-[2.6rem]">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[1.15rem] left-[0.5rem] w-[2.6rem] max-sm:left-[0.4rem] max-sm:w-[2rem]",
          released ? "border-t-2 border-purple-500" : "border-t-2 border-dashed border-purple-500",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[calc(1.15rem-4px)] left-[calc(0.5rem-3px)] size-2 rotate-45 max-sm:left-[calc(0.4rem-3px)]",
          released ? "bg-purple-500" : "border-2 border-purple-500 bg-background",
        )}
      />
      <span
        aria-hidden="true"
        className="absolute top-[calc(1.15rem-3px)] left-[calc(2.25rem-3px)] size-[7px] rounded-full bg-purple-500 max-sm:left-[calc(1.75rem-3px)]"
      />

      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-purple-700 dark:text-purple-300">
            {group.version ? `v${group.version}` : released ? "リリース済み" : "次のリリース"}
          </span>
          {released ? (
            <>
              {!inProduction && <DeployStateBadge deploy={group.deploy} />}
              <span className="text-xs text-muted-foreground">
                {group.mergedAt &&
                  `${formatDate(group.mergedAt)}に${inProduction ? "本番反映" : "mainへマージ"}`}
              </span>
              {/* 成功は日付の後ろへ回す。「本番反映」を主にし、その裏付けとして添える */}
              {inProduction && <DeployStateBadge deploy={group.deploy} />}
            </>
          ) : waitingUserMerge ? (
            // mainへのマージだけは人が行う。待っているのが人の操作であることを、
            // ヘッダーのリリース状況・スマホの一覧と同じ文言・同じ色で出す（#1579）
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
              mainへマージ待ち
            </span>
          ) : (
            <ReleaseProgressPill
              label={
                group.pullRequest
                  ? "リリース中"
                  : group.bumpPullRequest
                    ? "バージョンバンプ中"
                    : "本番未反映"
              }
              // 「本番未反映」はまだPRが無い状態なので、そもそもCIも走っていない
              spinning={isReleaseCiPending(group.pullRequest, group.bumpPullRequest)}
              note="チェック実行中"
            />
          )}
          {/* mainへのマージはこの画面で完結させる（#1548）。押すと本番デプロイまで走るため、
              `mergeWarnings`が返す警告で必ず確認ダイアログを通る */}
          {group.pullRequest && group.pullRequest.state === "open" && (
            <ReleaseMergeButton pullRequest={group.pullRequest} onMerged={onMerged} />
          )}
          {releaseButton}
        </div>
        {/* マージ導線は見出し側（`ReleaseMergeButton`）が持つので、この行には渡さない */}
        {group.pullRequest && <PullRequestLine pullRequest={group.pullRequest} />}
        {group.bumpPullRequest && (
          <BumpPullRequestLine
            pullRequest={group.bumpPullRequest}
            version={group.version}
            onMerged={onMerged}
          />
        )}
      </div>
    </li>
  );
}

/** バージョンの束に何件乗っているか。手作業が残っていればそれも出す */
function ReleaseGroupNote({ group }: { group: BranchFlowReleaseGroup }) {
  const released = group.mergedAt !== null;
  const parts = [
    `このバージョンに乗${released ? "った" : "る"}変更 ${group.lanes.length}件`,
    ...(group.openManualStepCount > 0 ? [`残っている手作業 ${group.openManualStepCount}件`] : []),
  ];

  return (
    <li className="pb-0.5 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
      {parts.join(" ・ ")}
    </li>
  );
}

/**
 * `main`と`develop`の2本のレールに、リリースの横線と作業ブランチの枝を並べた図（#1510）。
 *
 * **gitのコミットグラフではない。** 実際の分岐点やマージ順序は描かず、
 * 「どのバージョンにどのブランチ・PR・Issueが含まれるか」だけを縦に並べた模式図で、
 * 束の作り方は`lib/branch-flow.ts`が持つ（追加のGitHub API取得は無い）。
 *
 * 作業ブランチごとに列を増やすとスマホ幅で必ず溢れるため、**レールは2本に固定**し、
 * レールが占める幅もPC 3.35rem・スマホ 2.6remの固定にしている。横スクロールは出ない。
 *
 * **既定で出すのは「次のリリースに乗る分」まで**（#1586）。本番へ出た版の束は、いま何が出るのかを
 * 押し下げるだけなのでボタンで開くまで畳む。ただし**未完了の手作業だけは畳んでも別枠で出す**——
 * 版が出た後も残る作業で、隠すと画面のどこにも現れなくなるため。
 *
 * **「次のリリースに乗る分」が1件も無いときだけは、いちばん新しい版の束を既定で出す**（#1711）。
 * 本番へ出した直後がその状態で、押し下げるものが無いのに畳むと画面の中身が丸ごと消える。
 * デプロイ直後にこの画面を見に来る目的（今回何が出たのか・デプロイが通ったのか。#1579）が
 * そのままボタンの向こうへ隠れていた。
 */
function ReleaseFlowGraph({
  repository,
  showClosed,
  showAllVersions,
  showAllPlannedIssues,
  mergedPullRequestsLoaded,
  releaseTriggerPending,
  onShowAllVersions,
  onToggleAllPlannedIssues,
  onReleaseTriggered,
  onMerged,
}: {
  repository: BranchFlowRepository;
  showClosed: boolean;
  showAllVersions: boolean;
  /** 実装予定を全件出しているか（#1704）。既定は頭出しの3件まで */
  showAllPlannedIssues: boolean;
  mergedPullRequestsLoaded: boolean;
  /** すでに起動済みで、バンプPRが現れるのを待っている最中か（#1955） */
  releaseTriggerPending: boolean;
  onShowAllVersions: () => void;
  onToggleAllPlannedIssues: () => void;
  /** リリースworkflowを起こせた後（起動中の記録と、バンプPRを出すための取り直し） */
  onReleaseTriggered: () => void;
  /** PRをこの画面からマージできたとき（#1756） */
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  const activeLanes = showClosed
    ? repository.activeLanes
    : repository.activeLanes.filter((lane) => !isClosedLane(lane));
  const hiddenClosedCount = repository.activeLanes.length - activeLanes.length;

  // 既定で出すのは**次のリリースに乗る分まで**（#1586）。本番へ出た版の束と、どの版で出たか
  // 特定できないレーンは、すでに済んだ変更なのでボタンで開くまで出さない。
  //
  // **その「次のリリースに乗る分」が無いときは、いちばん新しい版の束を代わりに出す**（#1711）。
  // 未リリースの束は先頭にしか来ないので、どちらの場合も出すのは配列の先頭からの連続した並び。
  const pendingGroups = repository.releaseGroups.filter((group) => group.mergedAt === null);
  const visibleGroups = showAllVersions
    ? repository.releaseGroups
    : pendingGroups.length > 0
      ? pendingGroups
      : repository.releaseGroups.slice(0, 1);
  const hiddenGroups = repository.releaseGroups.slice(visibleGroups.length);
  const unassignedLanes = showAllVersions ? repository.unassignedLanes : [];
  // 版を特定できないレーンもボタンの向こうにいる（#1711）。**畳んだ束が無いときでもボタンを出す
  // 理由**で、ここを見ずに`hiddenGroups`だけで判断すると、開く手段が画面のどこにも無くなる。
  const hiddenUnassignedCount = showAllVersions ? 0 : repository.unassignedLanes.length;

  // 畳んだぶんに残っている手作業だけは別枠で出す（#1586）。束を開いているときは
  // レーンにぶら下がって出るので、ここでは出さない（二重に出さないため）
  const hiddenLanes = [
    ...hiddenGroups.flatMap((group) => group.lanes),
    ...(showAllVersions ? [] : repository.unassignedLanes),
  ];
  const remainingManualSteps = hiddenLanes
    .flatMap((lane) =>
      lane.manualSteps
        .filter((manualStep) => manualStep.state === "open")
        .map((manualStep) => ({ manualStep, branchName: lane.branchName })),
    )
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => other.manualStep.number === entry.manualStep.number) === index,
    );

  const unreleasedCommits = repository.release.comparison?.aheadBy ?? null;
  const pendingIssues = (repository.releaseGroups[0]?.mergedAt === null
    ? repository.releaseGroups[0].lanes
    : []
  ).flatMap((lane) => (lane.issue ? [lane.issue] : []));

  return (
    <div className="relative px-4 py-3">
      <div className="flex items-center gap-3 pb-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded bg-purple-500" />
          {MAIN_BRANCH}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded bg-primary" />
          {DEVELOP_BRANCH}
        </span>
        {unreleasedCommits !== null && unreleasedCommits > 0 && (
          <span>未リリース {unreleasedCommits}コミット</span>
        )}
      </div>

      <ul className="relative">
        {/* 2本のレール。行の高さによらず端まで伸ばす */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-[0.5rem] w-0.5 rounded bg-purple-500/50 max-sm:left-[0.4rem]"
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-[2.25rem] w-0.5 rounded bg-primary/40 max-sm:left-[1.75rem]"
        />

        {/* 上流（まだブランチが無いIssue）から下流（リリース済み）へ、上から下に並べる（#1704） */}
        <PlannedIssues
          repositoryFullName={repository.repositoryFullName}
          issues={repository.plannedIssues}
          showAll={showAllPlannedIssues}
          onToggleShowAll={onToggleAllPlannedIssues}
        />

        {activeLanes.map((lane) => (
          <LaneRow
            key={lane.key}
            repositoryFullName={repository.repositoryFullName}
            lane={lane}
            onMerged={onMerged}
          />
        ))}

        {visibleGroups.map((group, index) => (
          <ReleaseGroupHeaderWithLanes
            key={group.key}
            repositoryFullName={repository.repositoryFullName}
            group={group}
            onMerged={onMerged}
            releaseButton={
              index === 0 && repository.canTriggerRelease ? (
                <RepositoryReleaseButton
                  repositoryFullName={repository.repositoryFullName}
                  pendingIssues={pendingIssues}
                  currentVersion={repository.release.latestVersion}
                  isPending={releaseTriggerPending}
                  onTriggered={onReleaseTriggered}
                />
              ) : undefined
            }
          />
        ))}

        {unassignedLanes.length > 0 && (
          <>
            <li className="pt-3 pb-0.5 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
              どの版で本番へ出たか特定できない変更 {unassignedLanes.length}件
              （取得したPRの範囲より古いもの）
            </li>
            {unassignedLanes.map((lane) => (
              <LaneRow
                key={lane.key}
                repositoryFullName={repository.repositoryFullName}
                lane={lane}
                onMerged={onMerged}
              />
            ))}
          </>
        )}

        {/* **マージ済みのPRが揃うまでは、リリース済みについて何も言い切らない**（#1711）。
            この段階で「リリース済みのバージョンは無い」「作業はありません」と描くと、
            本番デプロイ直後（＝進行中の作業も無い）に画面が空になり、開くボタンも消える */}
        {!mergedPullRequestsLoaded ? (
          <li className="py-2 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
            リリース済みのバージョンを読み込み中...
          </li>
        ) : (
          <>
            {(hiddenGroups.length > 0 || hiddenUnassignedCount > 0 || hiddenClosedCount > 0) && (
              <li className="pt-2 pl-[3.35rem] max-sm:pl-[2.6rem]">
                {(hiddenGroups.length > 0 || hiddenUnassignedCount > 0) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={onShowAllVersions}
                  >
                    {hiddenGroups.length > 0
                      ? `リリース済みのバージョンを表示（${hiddenGroups.length}件）`
                      : `本番へ出た変更を表示（${hiddenUnassignedCount}件）`}
                  </Button>
                )}
                {hiddenClosedCount > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    クローズ（未マージ）{hiddenClosedCount}件は隠しています
                  </span>
                )}
              </li>
            )}

            {activeLanes.length === 0 &&
              visibleGroups.length === 0 &&
              unassignedLanes.length === 0 && (
                <li className="py-2 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
                  developへ向かっている作業はありません。
                </li>
              )}
          </>
        )}
      </ul>

      {remainingManualSteps.length > 0 && (
        <RemainingManualSteps
          repositoryFullName={repository.repositoryFullName}
          manualSteps={remainingManualSteps}
        />
      )}

      {repository.orphanIssues.length > 0 && (
        <div className="mt-3 rounded-md border border-dashed p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <TriangleAlert className="size-3.5 text-amber-600" aria-hidden="true" />
            ブランチもPRも見つからないIssue
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {repository.orphanIssues.map((issue) => (
              <li key={issue.number}>
                <IssueLine
                  repositoryFullName={repository.repositoryFullName}
                  issue={issue}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReleaseGroupHeaderWithLanes({
  repositoryFullName,
  group,
  releaseButton,
  onMerged,
}: {
  repositoryFullName: string;
  group: BranchFlowReleaseGroup;
  releaseButton?: React.ReactNode;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  return (
    <>
      <ReleaseGroupHeader group={group} releaseButton={releaseButton} onMerged={onMerged} />
      {group.lanes.length > 0 && <ReleaseGroupNote group={group} />}
      {group.lanes.map((lane) => (
        <LaneRow
          key={lane.key}
          repositoryFullName={repositoryFullName}
          lane={lane}
          onMerged={onMerged}
        />
      ))}
    </>
  );
}

/**
 * 畳んだ行に出す件数（#1886）。**種類はアイコンと色で出し、言葉はツールチップと読み上げに持たせる。**
 *
 * 予定・進行中・未リリースが同じ灰色の文字で横に並んでいたため、右端まで読まないとどれが
 * リリース待ちなのか分からなかった。**形（破線の丸／枝分かれ／上向き矢印）でも区別が付く**ので、
 * 色を見分けにくくても読める。手が要るもの（CI失敗・手作業）のピルより静かなままにして、
 * 目立ち方の順序を崩さない。
 */
function SummaryCount({
  icon: Icon,
  label,
  count,
  className,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  className?: string;
}) {
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {count}
    </span>
  );
}

/**
 * 畳んだときの1行（#1510）。
 *
 * **右側に出すのは「手が要るか」だけ。** 8リポジトリを1画面へ収めるための行なので、
 * ここで詳細を語らない。リポジトリ名は`owner/`を落とし、フル名は`title`属性に持たせる。
 * 件数は`SummaryCount`でアイコンと数字だけにしている（#1886）。
 */
function RepositorySummaryRow({
  repository,
  branchesFailed,
  mergedPullRequestsLoaded,
  releaseTriggerPending,
  isOpen,
  onToggle,
}: {
  repository: BranchFlowRepository;
  branchesFailed: boolean;
  mergedPullRequestsLoaded: boolean;
  /** この端末からリリースworkflowを起こした直後で、まだバンプPRが現れていない（#1955） */
  releaseTriggerPending: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { summary } = repository;
  const unreleasedCommits = repository.release.comparison?.aheadBy ?? 0;
  // 「リリースする」を押してからバンプPRが現れるまでの間も、進んでいることをこの行に出す（#1955）。
  // **押せる状態（`canTriggerRelease`）のときだけ**にして、リリースが終わった後も10分間
  // localStorageに残る起動時刻で古いピルが出るのを防ぐ（ボタンの出し方と同じ条件）。
  const releaseLaunching = releaseTriggerPending && repository.canTriggerRelease;
  // 成功したデプロイは畳んだ行に出さない（静止している状態でバッジを埋めない。#1579）
  const deploy =
    summary.deploy && summary.deploy.kind !== "success" ? summary.deploy : null;
  const hasAnything =
    summary.activeLaneCount > 0 ||
    summary.releaseInProgress ||
    releaseLaunching ||
    deploy !== null ||
    unreleasedCommits > 0 ||
    summary.openManualStepCount > 0 ||
    summary.plannedIssueCount > 0 ||
    repository.orphanIssues.length > 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-left hover:bg-accent/50",
        isOpen && "bg-muted/60",
      )}
    >
      <ChevronRight
        className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
        aria-hidden="true"
      />
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: getRepoColor(repository.repositoryFullName) }}
        aria-hidden="true"
      />
      <span className="truncate text-xs font-semibold" title={repository.repositoryFullName}>
        {repository.repositoryFullName.split("/").at(-1)}
      </span>
      {repository.repositoryPrivate && (
        <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
      )}
      {repository.release.latestVersion && (
        <span className="shrink-0 text-xs text-muted-foreground">
          v{repository.release.latestVersion}
        </span>
      )}

      <span className="flex-1" />

      {summary.hasCiFailure && (
        <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
          CI失敗
        </span>
      )}
      {summary.releaseInProgress ? (
        <ReleaseProgressPill
          label="リリース中"
          spinning={summary.releaseCiPending}
          note="チェック実行中"
        />
      ) : (
        // 起動からバンプPRが現れるまでは、開いたときのボタン（「リリース起動中…」）にしか
        // 出ていなかった（#1955）。バンプPRが現れれば上の「リリース中」へ引き継がれる
        releaseLaunching && (
          <ReleaseProgressPill label="リリース起動中" spinning note="workflowの起動待ち" />
        )
      )}
      {/* マージ後もデプロイが終わるまでは本番へ出ていない。開かなくても分かるようにする（#1579） */}
      <DeployStateBadge deploy={deploy} compact linkToRun={false} />

      {/* リリースPRのマージ待ちはリリース中のピルが表すので、重ねて出さない */}
      {summary.needsUserMerge && (
        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
          ユーザーのマージが必要
        </span>
      )}
      {/* 手作業は畳んだ束にも残る（#1586）。開かなくても残っていることが分かるようにする */}
      {summary.openManualStepCount > 0 && (
        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
          手作業{summary.openManualStepCount}
        </span>
      )}
      {/* 開かなくても、これから流れてくるものが溜まっているかが分かるようにする（#1704）。
          破線の丸は流れ図の実装予定ノードと同じ描き方で、まだブランチが無いことを形で出す */}
      {summary.plannedIssueCount > 0 && (
        <SummaryCount
          icon={CircleDashed}
          label={`実装予定 ${summary.plannedIssueCount}件`}
          count={summary.plannedIssueCount}
        />
      )}
      {summary.activeLaneCount > 0 && (
        <SummaryCount
          icon={GitBranch}
          label={`進行中 ${summary.activeLaneCount}件`}
          count={summary.activeLaneCount}
          className="text-sky-600 dark:text-sky-400"
        />
      )}
      {/* 未リリースは「リリース中」のピルと同じ紫にして、同じリリースの軸だと分かるようにする（#1886） */}
      {unreleasedCommits > 0 && !summary.releaseInProgress && !releaseLaunching && (
        <SummaryCount
          icon={ArrowUpToLine}
          label={`未リリース ${unreleasedCommits}コミット`}
          count={unreleasedCommits}
          className="text-purple-600 dark:text-purple-400"
        />
      )}
      {branchesFailed && (
        <span className="shrink-0 text-xs text-muted-foreground">ブランチ状況を取得できず</span>
      )}
      {/* 取得が済むまで「動きなし」と言い切らない（#1711）。マージ済みのPRが揃っていない間は
          進行中の件数も版も出せず、静かなだけなのか読み込み中なのかを行から区別できない */}
      {!hasAnything && !branchesFailed && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {mergedPullRequestsLoaded ? "動きなし" : "読み込み中"}
        </span>
      )}
    </button>
  );
}

/**
 * リポジトリ1件ぶん（畳んだ1行＋開いた中身）。
 *
 * **切り出したのは、起動中（`useReleaseTriggerPending`）を1か所で持つため**（#1955）。
 * 起動時刻は端末のlocalStorageにあるが、同じキーを畳んだ行とボタンの2か所から読むと
 * 押した瞬間の書き込みが互いに伝わらない。ここで1回だけ読み、行とボタンへ配る。
 */
function RepositorySection({
  repository,
  branchesFailed,
  mergedPullRequestsLoaded,
  showClosed,
  showAllVersions,
  showAllPlannedIssues,
  isOpen,
  onToggle,
  onShowAllVersions,
  onToggleAllPlannedIssues,
  onRefresh,
  onMerged,
}: {
  repository: BranchFlowRepository;
  branchesFailed: boolean;
  mergedPullRequestsLoaded: boolean;
  showClosed: boolean;
  showAllVersions: boolean;
  showAllPlannedIssues: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onShowAllVersions: () => void;
  onToggleAllPlannedIssues: () => void;
  /** リリースworkflowを起こした後の取り直し */
  onRefresh: () => void;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  const { isPending, markTriggered } = useReleaseTriggerPending(repository.repositoryFullName);

  return (
    <section>
      <RepositorySummaryRow
        repository={repository}
        branchesFailed={branchesFailed}
        mergedPullRequestsLoaded={mergedPullRequestsLoaded}
        releaseTriggerPending={isPending}
        isOpen={isOpen}
        onToggle={onToggle}
      />
      {isOpen && (
        <div className="border-b">
          <ReleaseFlowGraph
            repository={repository}
            showClosed={showClosed}
            showAllVersions={showAllVersions}
            showAllPlannedIssues={showAllPlannedIssues}
            mergedPullRequestsLoaded={mergedPullRequestsLoaded}
            releaseTriggerPending={isPending}
            onShowAllVersions={onShowAllVersions}
            onToggleAllPlannedIssues={onToggleAllPlannedIssues}
            onReleaseTriggered={() => {
              markTriggered();
              onRefresh();
            }}
            onMerged={onMerged}
          />
        </div>
      )}
    </section>
  );
}

/**
 * 手を動かす必要があるリポジトリか。ヘッダーの「手が要るもの◯件」に数える（#1510）。
 *
 * **開く条件ではない**（#1932）。初回に自動で開く動きはやめたので、この判定が変える表示は
 * ヘッダーの件数だけで、開くかどうかはユーザーが決める。
 *
 * **デプロイ中も含める**（#1579）。押す操作は無いが、mainへマージしてから本番へ出るまでの間は
 * 「今どこまで来ているか」を見に来る時間そのもので、件数から漏らすと見に来る手掛かりが無い。
 *
 * **「リリース起動中」（#1955）だけは含めない。** 押す操作の有無ではなく、判断の材料が
 * 端末ローカルの記録（起動時刻をlocalStorageへ置き、10分で失効する）でしかないため——
 * 数えると、同じ画面をどの端末で見るかによってヘッダーの件数が食い違う。畳んだ行のピルは
 * 押した端末にだけ出るもので、そこで閉じている。
 */
function needsAttention(repository: BranchFlowRepository): boolean {
  const { summary } = repository;
  const deploying = summary.deploy !== null && summary.deploy.kind !== "success";
  return summary.hasCiFailure || summary.needsUserMerge || summary.releaseInProgress || deploying;
}

/**
 * Issue・ブランチ・PRの関係を、リポジトリごとの「流れ」として1画面で見せる（#1455・#1510）。
 *
 * Issue一覧・PR一覧はどちらも「一方から他方を辿る」導線しか持たず、
 * 「どのIssueがどのブランチのどのPRになっていて、どこまで来ているのか」を俯瞰できなかった。
 *
 * **既定は全リポジトリを1行に畳む**（#1510）。8リポジトリを扱う画面なのに1画面へ2件しか
 * 入らず、動きの無いリポジトリまでフルサイズで「何も無い」と言っていたため。
 * **開いた直後は自動で展開しない**（#1932）。手が要るもの（CI失敗・ユーザーのマージ待ち・
 * リリース中）を初回に開く動きは、初期表示が縦に伸びるためやめた。
 *
 * 展開した中身は`ReleaseFlowGraph`が持つ。組み立ては`lib/branch-flow.ts`の純粋関数が行い、
 * この層は描画だけを持つ。
 */
export function BranchFlowView({
  flow,
  fetchedAt,
  isLoading,
  isRefreshing,
  error,
  failedRepositories,
  mergedPullRequestsLoaded,
  expandedRepositoryFullNames = [],
  autoRefreshIntervalMs = null,
  onChangeAutoRefreshInterval,
  onRefresh,
  onMerged,
  headerLeading,
  headerActions,
  className,
  style,
  footerSpacing = false,
}: BranchFlowViewProps) {
  const [openRepositories, setOpenRepositories] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  const [allVersionsRepositories, setAllVersionsRepositories] = useState<Set<string>>(new Set());
  // 実装予定を全件出しているリポジトリ（#1704）。既定は頭出しの3件までで、押すたびに切り替える
  const [allPlannedRepositories, setAllPlannedRepositories] = useState<Set<string>>(new Set());
  const attentionRepositories = flow.repositories.filter(needsAttention);

  // **取得に失敗したときは読み込み中で止めない**（#1711）。`error`は見出しのすぐ下に出ており、
  // そこへ終わらない「読み込み中」を重ねると、待てば直るものとして読めてしまう。
  // 失敗しているときは従来どおりの表示（＝取れた範囲で描く）に戻す。
  const releasesLoaded = mergedPullRequestsLoaded || error !== null;

  // **手が要るリポジトリを初回に自動で開くのはやめた**（#1932）。#1510・#1711では
  // CI失敗・マージ待ち・リリース中のリポジトリを開いた直後に展開していたが、そのぶん
  // 初期表示が縦に伸び、全リポジトリを1行に畳んで俯瞰する画面の趣旨と食い違っていた。
  // 手が要ることはヘッダーの「手が要るもの◯件」と畳んだ行のバッジが伝えるので、
  // 開くかどうかはユーザーが決める（行のクリック・「すべて開く」）。

  // 左メニューで選択中のリポジトリを開いた状態にする（#1750）。**開く向きにしか働かせない**——
  // 選択が外れたときに畳むと、見ていたリポジトリが勝手に閉じる。手で開閉したぶんも残す。
  // 反映済みの選択を覚え、同じ選択で開き直さない（手で畳んだものが再描画のたびに開くのを防ぐ）
  const expandedKey = expandedRepositoryFullNames.join(",");
  const appliedExpandedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (appliedExpandedKeyRef.current === expandedKey) return;
    appliedExpandedKeyRef.current = expandedKey;
    if (expandedKey === "") return;
    const names = expandedKey.split(",");
    // 選択が変わった瞬間にだけ開く（refで1回に抑えてある）ので、描画のたびには走らない
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenRepositories((prev) => new Set([...prev, ...names]));
  }, [expandedKey]);

  // マージ後の後始末は親が持つ（#1756）。渡されていない場合は取り直すだけに縮退させる
  function handleMerged(pullRequest: PullRequestSummary) {
    if (onMerged) onMerged(pullRequest);
    else onRefresh();
  }

  function toggleRepository(fullName: string) {
    setOpenRepositories((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  const allOpen =
    flow.repositories.length > 0 && openRepositories.size === flow.repositories.length;

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      {/*
        スマホ（`md`未満）ではヘッダーを2段にする（#1638）。1段のままだと、見出しと
        「すべて開く」「クローズも表示」「更新」＋実行状況で幅を食い合い、見出しと
        「◯リポジトリ・◯時点」が数文字まで潰れる。PCは従来どおり1段
      */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 md:flex-nowrap">
        {headerLeading}
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 md:basis-auto">
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-sm font-semibold"
              title="Issue・ブランチ・Pull Requestの関係とマージ先までの流れ"
            >
              ブランチ
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              <span>{flow.repositories.length}リポジトリ</span>
              {/* 絞り込みではなく展開で効かせていることを画面に出す（#1750）。
                  出さないと「リポジトリを選んだのに件数が減らない」ようにしか見えない */}
              {expandedRepositoryFullNames.length > 0 && (
                <span>{` ・ 絞り込み中の${expandedRepositoryFullNames.length}件を展開`}</span>
              )}
              {attentionRepositories.length > 0 && (
                <span>{` ・ 手が要るもの${attentionRepositories.length}件`}</span>
              )}
              {fetchedAt && <span>{` ・ ${formatTime(fetchedAt)}時点`}</span>}
              {/* 何分間隔で更新中なのかを画面に出す（#1767）。更新アイコンが回っているだけでは
                  「いま取りに行った」ことしか分からず、次にいつ更新されるかが読めない */}
              {autoRefreshIntervalMs !== null && (
                <span>{` ・ 自動更新${autoRefreshIntervalLabel(autoRefreshIntervalMs)}`}</span>
              )}
            </p>
          </div>
          {/* 見出しと同じ段に置く（#1638）。実行状況はどの画面でも1段目の右端で揃える */}
          {headerActions}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0"
          onClick={() =>
            setOpenRepositories(
              allOpen
                ? new Set()
                : new Set(flow.repositories.map((repo) => repo.repositoryFullName)),
            )
          }
        >
          {allOpen ? "すべて閉じる" : "すべて開く"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0"
          onClick={() => setShowClosed((prev) => !prev)}
        >
          {showClosed ? "クローズを隠す" : "クローズも表示"}
        </Button>
        {/* 更新ボタンと自動更新のメニューを1つのまとまりとして並べる（#1767）。
            ヘッダーは既に「すべて開く」「クローズも表示」で埋まっているため、
            間隔の選択は独立したボタンにせず更新ボタンの右端へ付ける */}
        <div className="flex shrink-0 items-center">
          <Button
            size="sm"
            variant="ghost"
            className={cn("h-8 shrink-0", onChangeAutoRefreshInterval && "rounded-r-none pr-1.5")}
            disabled={isLoading}
            onClick={onRefresh}
          >
            {/* 回転させる条件は`isRefreshing`（自動更新でも回る。#1767）。ボタンを押せなく
                するのは手動更新のときだけなので、こちらは`isLoading`のまま */}
            <RefreshCw className={cn("size-3.5", (isRefreshing ?? isLoading) && "animate-spin")} />
            更新
          </Button>
          {onChangeAutoRefreshInterval && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 shrink-0 rounded-l-none px-1.5"
                  aria-label={
                    autoRefreshIntervalMs === null
                      ? "自動更新の間隔（現在: 自動更新しない）"
                      : `自動更新の間隔（現在: ${autoRefreshIntervalLabel(autoRefreshIntervalMs)}）`
                  }
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup
                  value={String(autoRefreshIntervalMs)}
                  onValueChange={(value) =>
                    onChangeAutoRefreshInterval(value === "null" ? null : Number(value))
                  }
                >
                  {AUTO_REFRESH_INTERVAL_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

        {!error && flow.repositories.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {isLoading ? "読み込み中..." : "表示できるリポジトリがありません。"}
          </p>
        )}

        {flow.repositories.map((repository) => (
          <RepositorySection
            key={repository.repositoryFullName}
            repository={repository}
            branchesFailed={failedRepositories.includes(repository.repositoryFullName)}
            mergedPullRequestsLoaded={releasesLoaded}
            showClosed={showClosed}
            showAllVersions={allVersionsRepositories.has(repository.repositoryFullName)}
            showAllPlannedIssues={allPlannedRepositories.has(repository.repositoryFullName)}
            isOpen={openRepositories.has(repository.repositoryFullName)}
            onToggle={() => toggleRepository(repository.repositoryFullName)}
            onShowAllVersions={() =>
              setAllVersionsRepositories(
                (prev) => new Set([...prev, repository.repositoryFullName]),
              )
            }
            onToggleAllPlannedIssues={() =>
              setAllPlannedRepositories((prev) => {
                const next = new Set(prev);
                if (next.has(repository.repositoryFullName)) {
                  next.delete(repository.repositoryFullName);
                } else {
                  next.add(repository.repositoryFullName);
                }
                return next;
              })
            }
            onRefresh={onRefresh}
            onMerged={handleMerged}
          />
        ))}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
