"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Loader2,
  Lock,
  RefreshCw,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  CiStateBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { RepositoryReleaseButton } from "@/components/dashboard/repository-release-button";
import { Button } from "@/components/ui/button";
import { DEVELOP_BRANCH, MAIN_BRANCH, isClosedLane, type BranchFlow } from "@/lib/branch-flow";
import { getProgressStatusDef } from "@/lib/issue-progress";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type {
  BranchFlowDeployState,
  BranchFlowDeployStateKind,
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowManualStep,
  BranchFlowReleaseGroup,
  BranchFlowRepository,
} from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

type BranchFlowViewProps = {
  flow: BranchFlow;
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  /** ブランチ状況を取得できなかったリポジトリ（PRだけで組み立てている） */
  failedRepositories: string[];
  onRefresh: () => void;
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
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
}: {
  repositoryFullName: string;
  manualStep: BranchFlowManualStep;
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
    </div>
  );
}

function PullRequestLine({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const kindLabel = pullRequestKindLabel(pullRequest.kind);

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
}: {
  repositoryFullName: string;
  lane: BranchFlowLane;
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
          <PullRequestLine key={pullRequest.id} pullRequest={pullRequest} />
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
  onMerged: () => void;
}) {
  return (
    <PullRequestMergeButton
      pullRequest={pullRequest}
      onMerged={onMerged}
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
  onMerged: () => void;
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
  onRefresh,
}: {
  group: BranchFlowReleaseGroup;
  releaseButton?: React.ReactNode;
  onRefresh: () => void;
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
          ) : (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
                waitingUserMerge
                  ? // mainへのマージだけは人が行う。待っているのが人の操作であることを、
                    // ヘッダーのリリース状況・スマホの一覧と同じ文言・同じ色で出す（#1579）
                    "bg-amber-500/15 font-medium text-amber-700 ring-amber-500 dark:text-amber-400"
                  : "bg-purple-500/15 text-purple-700 ring-purple-500 dark:text-purple-300",
              )}
            >
              {waitingUserMerge
                ? "mainへマージ待ち"
                : group.pullRequest
                  ? "リリース中"
                  : group.bumpPullRequest
                    ? "バージョンバンプ中"
                    : "本番未反映"}
            </span>
          )}
          {/* mainへのマージはこの画面で完結させる（#1548）。押すと本番デプロイまで走るため、
              `mergeWarnings`が返す警告で必ず確認ダイアログを通る */}
          {group.pullRequest && group.pullRequest.state === "open" && (
            <ReleaseMergeButton pullRequest={group.pullRequest} onMerged={onRefresh} />
          )}
          {releaseButton}
        </div>
        {group.pullRequest && <PullRequestLine pullRequest={group.pullRequest} />}
        {group.bumpPullRequest && (
          <BumpPullRequestLine
            pullRequest={group.bumpPullRequest}
            version={group.version}
            onMerged={onRefresh}
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
 */
function ReleaseFlowGraph({
  repository,
  showClosed,
  showAllVersions,
  onShowAllVersions,
  onRefresh,
}: {
  repository: BranchFlowRepository;
  showClosed: boolean;
  showAllVersions: boolean;
  onShowAllVersions: () => void;
  onRefresh: () => void;
}) {
  const activeLanes = showClosed
    ? repository.activeLanes
    : repository.activeLanes.filter((lane) => !isClosedLane(lane));
  const hiddenClosedCount = repository.activeLanes.length - activeLanes.length;

  // 既定で出すのは「未リリース」と「ひとつ前の版」まで。それ以前はボタンで開く（#1510）
  const visibleGroups = showAllVersions
    ? repository.releaseGroups
    : repository.releaseGroups.slice(0, 2);
  const hiddenGroupCount = repository.releaseGroups.length - visibleGroups.length;

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

        {activeLanes.map((lane) => (
          <LaneRow
            key={lane.key}
            repositoryFullName={repository.repositoryFullName}
            lane={lane}
          />
        ))}

        {visibleGroups.map((group, index) => (
          <ReleaseGroupHeaderWithLanes
            key={group.key}
            repositoryFullName={repository.repositoryFullName}
            group={group}
            onRefresh={onRefresh}
            releaseButton={
              index === 0 && repository.canTriggerRelease ? (
                <RepositoryReleaseButton
                  repositoryFullName={repository.repositoryFullName}
                  pendingIssues={pendingIssues}
                  currentVersion={repository.release.latestVersion}
                  onTriggered={onRefresh}
                />
              ) : undefined
            }
          />
        ))}

        {repository.unassignedLanes.length > 0 && (
          <>
            <li className="pt-3 pb-0.5 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
              どの版で本番へ出たか特定できない変更 {repository.unassignedLanes.length}件
              （取得したPRの範囲より古いもの）
            </li>
            {repository.unassignedLanes.map((lane) => (
              <LaneRow
                key={lane.key}
                repositoryFullName={repository.repositoryFullName}
                lane={lane}
              />
            ))}
          </>
        )}

        {(hiddenGroupCount > 0 || hiddenClosedCount > 0) && (
          <li className="pt-2 pl-[3.35rem] max-sm:pl-[2.6rem]">
            {hiddenGroupCount > 0 && (
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onShowAllVersions}>
                さらに前のバージョンを表示（{hiddenGroupCount}件）
              </Button>
            )}
            {hiddenClosedCount > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                クローズ（未マージ）{hiddenClosedCount}件は隠しています
              </span>
            )}
          </li>
        )}

        {activeLanes.length === 0 && repository.releaseGroups.length === 0 && (
          <li className="py-2 pl-[3.35rem] text-xs text-muted-foreground max-sm:pl-[2.6rem]">
            developへ向かっている作業はありません。
          </li>
        )}
      </ul>

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
  onRefresh,
}: {
  repositoryFullName: string;
  group: BranchFlowReleaseGroup;
  releaseButton?: React.ReactNode;
  onRefresh: () => void;
}) {
  return (
    <>
      <ReleaseGroupHeader group={group} releaseButton={releaseButton} onRefresh={onRefresh} />
      {group.lanes.length > 0 && <ReleaseGroupNote group={group} />}
      {group.lanes.map((lane) => (
        <LaneRow key={lane.key} repositoryFullName={repositoryFullName} lane={lane} />
      ))}
    </>
  );
}

/**
 * 畳んだときの1行（#1510）。
 *
 * **右側に出すのは「手が要るか」だけ。** 8リポジトリを1画面へ収めるための行なので、
 * ここで詳細を語らない。リポジトリ名は`owner/`を落とし、フル名は`title`属性に持たせる。
 */
function RepositorySummaryRow({
  repository,
  branchesFailed,
  isOpen,
  onToggle,
}: {
  repository: BranchFlowRepository;
  branchesFailed: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { summary } = repository;
  const unreleasedCommits = repository.release.comparison?.aheadBy ?? 0;
  // 成功したデプロイは畳んだ行に出さない（静止している状態でバッジを埋めない。#1579）
  const deploy =
    summary.deploy && summary.deploy.kind !== "success" ? summary.deploy : null;
  const hasAnything =
    summary.activeLaneCount > 0 ||
    summary.releaseInProgress ||
    deploy !== null ||
    unreleasedCommits > 0 ||
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
      {summary.releaseInProgress && (
        <span className="shrink-0 rounded-full bg-purple-500/15 px-2 py-0.5 text-xs text-purple-700 ring-1 ring-inset ring-purple-500 dark:text-purple-300">
          リリース中
        </span>
      )}
      {/* マージ後もデプロイが終わるまでは本番へ出ていない。開かなくても分かるようにする（#1579） */}
      <DeployStateBadge deploy={deploy} compact linkToRun={false} />

      {/* リリースPRのマージ待ちはリリース中のピルが表すので、重ねて出さない */}
      {summary.needsUserMerge && (
        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
          ユーザーのマージが必要
        </span>
      )}
      {summary.activeLaneCount > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">
          進行中{summary.activeLaneCount}
        </span>
      )}
      {unreleasedCommits > 0 && !summary.releaseInProgress && (
        <span className="shrink-0 text-xs text-muted-foreground">未リリース{unreleasedCommits}</span>
      )}
      {branchesFailed && (
        <span className="shrink-0 text-xs text-muted-foreground">ブランチ状況を取得できず</span>
      )}
      {!hasAnything && !branchesFailed && (
        <span className="shrink-0 text-xs text-muted-foreground">動きなし</span>
      )}
    </button>
  );
}

/**
 * 手を動かす必要があるリポジトリか。既定で開く条件でもある（#1510）。
 *
 * **デプロイ中も含める**（#1579）。押す操作は無いが、mainへマージしてから本番へ出るまでの間は
 * 「今どこまで来ているか」を見に来る時間そのもので、畳んだままだと見に来た意味が無い。
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
 * 手が要るもの（CI失敗・ユーザーのマージ待ち・リリース中）だけを初回に開く。
 *
 * 展開した中身は`ReleaseFlowGraph`が持つ。組み立ては`lib/branch-flow.ts`の純粋関数が行い、
 * この層は描画だけを持つ。
 */
export function BranchFlowView({
  flow,
  fetchedAt,
  isLoading,
  error,
  failedRepositories,
  onRefresh,
  headerLeading,
  className,
  style,
  footerSpacing = false,
}: BranchFlowViewProps) {
  const [openRepositories, setOpenRepositories] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  const [allVersionsRepositories, setAllVersionsRepositories] = useState<Set<string>>(new Set());
  // 初回に一度だけ自動で開く。以降の再取得でユーザーの開閉を上書きしない
  const autoOpenedRef = useRef(false);

  const attentionRepositories = flow.repositories.filter(needsAttention);

  useEffect(() => {
    if (autoOpenedRef.current || flow.repositories.length === 0) return;
    autoOpenedRef.current = true;
    setOpenRepositories(
      new Set(flow.repositories.filter(needsAttention).map((repo) => repo.repositoryFullName)),
    );
  }, [flow.repositories]);

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
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        {headerLeading}
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-sm font-semibold"
            title="Issue・ブランチ・Pull Requestの関係とマージ先までの流れ"
          >
            ブランチとPRの流れ
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            <span>{flow.repositories.length}リポジトリ</span>
            {attentionRepositories.length > 0 && (
              <span>{` ・ 手が要るもの${attentionRepositories.length}件`}</span>
            )}
            {fetchedAt && <span>{` ・ ${formatTime(fetchedAt)}時点`}</span>}
          </p>
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

        {!error && flow.repositories.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {isLoading ? "読み込み中..." : "表示できるリポジトリがありません。"}
          </p>
        )}

        {flow.repositories.map((repository) => {
          const isOpen = openRepositories.has(repository.repositoryFullName);
          return (
            <section key={repository.repositoryFullName}>
              <RepositorySummaryRow
                repository={repository}
                branchesFailed={failedRepositories.includes(repository.repositoryFullName)}
                isOpen={isOpen}
                onToggle={() => toggleRepository(repository.repositoryFullName)}
              />
              {isOpen && (
                <div className="border-b">
                  <ReleaseFlowGraph
                    repository={repository}
                    showClosed={showClosed}
                    showAllVersions={allVersionsRepositories.has(repository.repositoryFullName)}
                    onShowAllVersions={() =>
                      setAllVersionsRepositories(
                        (prev) => new Set([...prev, repository.repositoryFullName]),
                      )
                    }
                    onRefresh={onRefresh}
                  />
                </div>
              )}
            </section>
          );
        })}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
