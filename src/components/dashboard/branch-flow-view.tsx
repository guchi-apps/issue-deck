"use client";

import { useState, type CSSProperties } from "react";
import { CircleDashed, GitBranch, Lock, RefreshCw, TriangleAlert } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  CiStateBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { Button } from "@/components/ui/button";
import { DEVELOP_BRANCH, MAIN_BRANCH, isCompletedLane, type BranchFlow } from "@/lib/branch-flow";
import { getProgressStatusDef } from "@/lib/issue-progress";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type {
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowRelease,
  BranchFlowReleaseState,
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

// レーンはすべてdevelopへ向かう作業なので、「マージ済み」だけでは本番へ出たのかが読めない。
// developまで来たことを明示し、本番へ出たかどうかは`ReleaseStateBadge`が受け持つ。
const LANE_STATUS_LABEL: Record<BranchFlowLaneStatus, string> = {
  "no-pull-request": "PR未作成",
  open: "マージ待ち",
  merged: "developへマージ済み",
  closed: "クローズ（未マージ）",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** 幹（main・develop）のノード。レーンの合流先が何かを明示する */
function TrunkNode({ name, version }: { name: string; version?: string | null }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{name}</code>
      {version && <span className="text-xs text-muted-foreground">v{version}</span>}
    </div>
  );
}

/**
 * マージ済みの作業がどのバージョンで本番へ出たか（#1455）。
 *
 * developへのマージだけでは本番に出ていないため、「マージ済み」と「本番反映済み」は別に出す。
 * 版を断定できない場合（取得しているクローズ済みPRの範囲より古い）は、
 * 誤った版を出さずに「バージョン不明」と表示する。
 */
function ReleaseStateBadge({ state }: { state: BranchFlowReleaseState }) {
  if (state.kind === "pending") {
    return <PullRequestMetaBadge>main未反映</PullRequestMetaBadge>;
  }
  if (state.kind === "unknown") {
    return <PullRequestMetaBadge>本番反映のバージョン不明</PullRequestMetaBadge>;
  }
  return (
    <span className="shrink-0 rounded-full bg-purple-500/15 px-2 py-0.5 text-xs text-purple-700 ring-1 ring-inset ring-purple-500 dark:text-purple-300">
      {state.version ? `v${state.version}で本番反映` : "本番反映済み"}
    </span>
  );
}

/** レーンの状態を表すピル。進行中（マージ待ち）だけ色を付ける */
function LaneStatusBadge({ status }: { status: BranchFlowLaneStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
        status === "open"
          ? "bg-primary/15 text-primary ring-primary"
          : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {LANE_STATUS_LABEL[status]}
    </span>
  );
}

function IssueLine({
  repositoryFullName,
  issue,
  prefix,
}: {
  repositoryFullName: string;
  issue: BranchFlowIssueRef;
  /** 「関連Issue」のように、対応Issueと区別する見出しを付ける場合 */
  prefix?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {prefix && <span className="shrink-0 text-xs text-muted-foreground">{prefix}</span>}
      <GithubReferenceLink
        href={`https://github.com/${repositoryFullName}/issues/${issue.number}`}
        reference={{ repositoryFullName, number: issue.number, kind: "issue" }}
        className="min-w-0 max-w-full truncate text-xs text-primary hover:underline"
      >
        Issue #{issue.number}
        {issue.title ? ` ${issue.title}` : ""}
      </GithubReferenceLink>
      {issue.progress && (
        <PullRequestMetaBadge>{getProgressStatusDef(issue.progress).label}</PullRequestMetaBadge>
      )}
      {issue.state === null && <PullRequestMetaBadge>一覧に無いIssue</PullRequestMetaBadge>}
      {issue.state === "closed" && <PullRequestMetaBadge>クローズ済み</PullRequestMetaBadge>}
    </div>
  );
}

function PullRequestLine({ pullRequest }: { pullRequest: PullRequestSummary }) {
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
        className="min-w-0 max-w-full truncate text-xs font-medium hover:underline"
      >
        #{pullRequest.number} {pullRequest.title}
      </GithubReferenceLink>
      {pullRequest.draft ? (
        <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>
      ) : (
        pullRequest.state === "open" && <CiStateBadge ciState={pullRequest.ciState} />
      )}
      {pullRequest.autoMergeEnabled && <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>}
    </div>
  );
}

/**
 * `develop`へ向かう作業1本。「ブランチ → PR → Issue」を上から下へ並べる。
 *
 * 横に並べるとスマホ幅で必ず折り返して読めなくなるため、1レーンを縦の小さなブロックにして
 * 幹からの枝として描いている。
 */
function LaneRow({
  repositoryFullName,
  lane,
}: {
  repositoryFullName: string;
  lane: BranchFlowLane;
}) {
  const kindLabel = pullRequestKindLabel(lane.kind);

  return (
    <li className="relative py-1.5">
      {/* 幹（左の縦線）からこのレーンへ伸びる枝 */}
      <span aria-hidden="true" className="absolute -left-3 top-4 h-px w-3 bg-border" />
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {lane.pullRequests.length === 0 ? (
            <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <code className="min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {lane.branchName}
          </code>
          <LaneStatusBadge status={lane.status} />
          {lane.releaseState && <ReleaseStateBadge state={lane.releaseState} />}
          {kindLabel && lane.kind !== "issue" && (
            <PullRequestMetaBadge>{kindLabel}</PullRequestMetaBadge>
          )}
        </div>

        {lane.pullRequests.map((pullRequest) => (
          <div key={pullRequest.id} className="pl-5">
            <PullRequestLine pullRequest={pullRequest} />
          </div>
        ))}

        <div className="flex flex-col gap-1 pl-5">
          {lane.issue ? (
            <IssueLine repositoryFullName={repositoryFullName} issue={lane.issue} />
          ) : (
            <span className="text-xs text-muted-foreground">対応Issue不明</span>
          )}
          {/* 1本のPRが複数のIssueを扱っている場合。本文の言及も混ざるため「関連」と明示する */}
          {lane.relatedIssues.map((issue) => (
            <IssueLine
              key={issue.number}
              repositoryFullName={repositoryFullName}
              issue={issue}
              prefix="関連"
            />
          ))}
        </div>
      </div>
    </li>
  );
}

/** `develop` → `main`（リリース）の区間 */
function ReleaseSection({ release }: { release: BranchFlowRelease }) {
  const aheadBy = release.comparison?.aheadBy ?? null;

  return (
    <ul className="ml-2 border-l pl-3">
      <li className="relative py-1.5">
        <span aria-hidden="true" className="absolute -left-3 top-4 h-px w-3 bg-border" />
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5">{DEVELOP_BRANCH}</code>
            <span aria-hidden="true">→</span>
            <code className="rounded bg-muted px-1.5 py-0.5">{MAIN_BRANCH}</code>
            <span>
              {aheadBy === null
                ? "差分は取得できませんでした"
                : aheadBy === 0
                  ? "未リリースの変更はありません"
                  : `未リリース ${aheadBy}コミット`}
            </span>
            {(release.comparison?.behindBy ?? 0) > 0 && (
              <PullRequestMetaBadge>
                mainに{release.comparison?.behindBy}コミットの未取り込みあり
              </PullRequestMetaBadge>
            )}
          </div>
          {release.pullRequest ? (
            <PullRequestLine pullRequest={release.pullRequest} />
          ) : (
            aheadBy !== null &&
            aheadBy > 0 && (
              <span className="text-xs text-muted-foreground">リリースPRは未作成です。</span>
            )
          )}
        </div>
      </li>
    </ul>
  );
}

function RepositoryCard({
  repository,
  showCompleted,
}: {
  repository: BranchFlowRepository;
  showCompleted: boolean;
}) {
  const lanes = showCompleted
    ? repository.lanes
    : repository.lanes.filter((lane) => !isCompletedLane(lane));
  const hiddenLaneCount = repository.lanes.length - lanes.length;

  return (
    <section className="border-b last:border-b-0">
      <h2 className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-2 text-xs font-semibold backdrop-blur">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: getRepoColor(repository.repositoryFullName) }}
          aria-hidden="true"
        />
        <span className="truncate">{repository.repositoryFullName}</span>
        {repository.repositoryPrivate && (
          <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
        )}
      </h2>

      <div className="px-4 py-3">
        <TrunkNode name={MAIN_BRANCH} version={repository.release.latestVersion} />
        <ReleaseSection release={repository.release} />
        <TrunkNode name={DEVELOP_BRANCH} />

        {lanes.length === 0 ? (
          <p className="ml-2 border-l pl-3 py-2 text-xs text-muted-foreground">
            developへ向かっている作業はありません。
          </p>
        ) : (
          <ul className="ml-2 border-l pl-3">
            {lanes.map((lane) => (
              <LaneRow
                key={lane.key}
                repositoryFullName={repository.repositoryFullName}
                lane={lane}
              />
            ))}
          </ul>
        )}

        {hiddenLaneCount > 0 && (
          <p className="ml-2 border-l pl-3 pt-1 text-xs text-muted-foreground">
            完了した作業{hiddenLaneCount}件は隠しています。
          </p>
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

        {!repository.branchesLoaded && (
          <p className="mt-2 text-xs text-muted-foreground">
            ブランチ状況を取得できていないため、PRのあるブランチだけを表示しています。
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Issue・ブランチ・PRの関係を、リポジトリごとの「流れ」として1画面で見せる（#1455）。
 *
 * Issue一覧・PR一覧はどちらも「一方から他方を辿る」導線しか持たず、
 * 「どのIssueがどのブランチのどのPRになっていて、どこまで来ているのか」を俯瞰できなかった。
 * ここでは`main ← develop ← 各作業ブランチ`という運用どおりの縦の流れに沿って並べ、
 * 1レーンに Issue・ブランチ・PR・CI状態をまとめて出す。
 *
 * 組み立ては`lib/branch-flow.ts`の純粋関数が行い、この層は描画だけを持つ。
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
  // 完了した作業まで出すと、動いている作業が下へ押し流されて読めなくなるため既定では畳む。
  const [showCompleted, setShowCompleted] = useState(false);

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
            {fetchedAt && <span>{` ・ ${formatTime(fetchedAt)}時点`}</span>}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0"
          onClick={() => setShowCompleted((prev) => !prev)}
        >
          {showCompleted ? "完了を隠す" : "完了も表示"}
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

        {failedRepositories.length > 0 && (
          <p className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            ブランチ状況を取得できなかったリポジトリがあります: {failedRepositories.join(", ")}
          </p>
        )}

        {!error && flow.repositories.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {isLoading ? "読み込み中..." : "進行中の作業があるリポジトリはありません。"}
          </p>
        )}

        {flow.repositories.map((repository) => (
          <RepositoryCard
            key={repository.repositoryFullName}
            repository={repository}
            showCompleted={showCompleted}
          />
        ))}

        {flow.quietRepositories.length > 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            動きのないリポジトリ（{flow.quietRepositories.length}件）は表示していません。
          </p>
        )}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
