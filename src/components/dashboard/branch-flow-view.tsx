"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Clock,
  ExternalLink,
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
  MergeJudgementBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  UserMergeRequiredBadge,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { RepositoryDeployButton } from "@/components/dashboard/repository-deploy-button";
import { RepositoryReleaseButton } from "@/components/dashboard/repository-release-button";
import { ResizeHandle } from "@/components/dashboard/resize-handle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  autoRefreshIntervalLabel,
  describeAutoRefreshState,
  describeRefreshButtonHint,
  type AutoRefreshIntervalMs,
} from "@/lib/auto-refresh";
import { useTriggerPending } from "@/hooks/use-trigger-pending";
import {
  DEVELOP_BRANCH,
  MAIN_BRANCH,
  isClosedLane,
  isReleaseCiPending,
  type BranchFlow,
} from "@/lib/branch-flow";
import { formatMonthDay, formatTimeOfDay } from "@/lib/format-date-time";
import { releaseMergeTargetLabel } from "@/lib/github/release-button-status";
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
  /**
   * デプロイ状況（`use-deploy-status.ts`）だけが回っている間隔（#1797）。回っていなければ`null`。
   *
   * この画面の既定は「自動更新しない」だが、**本番デプロイが動いている間はデプロイ状況だけが
   * 30秒ごとに取り直されている**。それを出さないと、画面には「手動更新のみ」と書いてあるのに
   * 表示が勝手に進む状態になる。
   */
  deployAutoRefreshIntervalMs?: AutoRefreshIntervalMs;
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
  /**
   * 一覧を下へ引っ張ったときに実行する更新（#1958）。**渡した画面でだけ有効になる。**
   * 引っ張るという操作はタッチにしか無く、PCの画面は渡さないので今までどおり
   * （Issue一覧の`onPullToRefresh`と同じ扱い。#1893）。
   */
  onPullToRefresh?: () => Promise<unknown> | void;
  /**
   * ヘッダーの更新ボタンを回転アイコンだけにするか（#1958）。スマホで渡す。
   *
   * 引っ張って更新できるようになったぶん「更新」の文字は要らなくなり、その幅を
   * 見出しと「◯リポジトリ・◯時点」の行へ回す。**押したときの動きと読み上げ用の名前は
   * 変えない**——引っ張れることに気づいていない人の手段を消さないため。
   */
  refreshIconOnly?: boolean;
  /**
   * PCで左右2ペインに分けるか（#2157）。**渡した画面でだけ有効になる**（スマホは渡さない）。
   *
   * 1カラムのまま行の下へ展開していたころは、横幅が余っているのに縦へ伸び、一覧と中身を
   * 同時に見られなかった。左に畳んだ1行だけを残し、流れ図は右ペインで独立してスクロールさせる。
   *
   * **渡しても幅が足りなければ従来どおり折りたたむ**（`SPLIT_MIN_WIDTH`）。左メニューを開いた
   * まま狭いウィンドウで見ると、右ペインが読めない幅まで潰れるため。
   */
  splitLayout?: boolean;
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
 * 左右2ペインに分けるのに要る、この画面自身の最小幅（#2157）。
 *
 * **見るのはウィンドウ幅ではなくこの画面が占めている幅。** 左メニューは畳めるうえ幅も
 * 変えられるので、同じウィンドウ幅でも中央に残る幅は倍近く違う。
 */
const SPLIT_MIN_WIDTH = 880;

/** 右ペインのid（#2157）。畳んだ1行の`aria-controls`が指す先 */
const DETAIL_PANE_ID = "branch-flow-detail";

/** 左ペイン（リポジトリ一覧）の幅（#2157）。左メニュー・Issue一覧と同じくドラッグで変えられる */
const LIST_PANE_WIDTH = {
  storageKey: "issue-deck:branch-flow-list-width",
  defaultWidth: 360,
  minWidth: 280,
  maxWidth: 640,
  handleSide: "right",
} as const;

/**
 * 要素の幅が閾値以上か（#2157）。
 *
 * CSSのブレークポイントでは足りない——分けるかどうかを決めるのはウィンドウ幅ではなく、
 * 左メニューを引いた残りの幅だから。`ResizeObserver`が無い環境（テストのjsdom・SSR）では
 * 初回の実測だけを使い、幅が取れなければ分割しない（＝従来の折りたたみ）側へ倒す。
 */
function useIsWiderThan(ref: RefObject<HTMLElement | null>, minWidth: number): boolean {
  const [isWide, setIsWide] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    // 実測した値を状態へ移すだけで、描画のたびに走るものではない（ResizeObserverが呼ぶ）
    const measure = () => setIsWide(element.getBoundingClientRect().width >= minWidth);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, minWidth]);

  return isWide;
}

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

/**
 * 画面から起こした出し直し（#2020）の文言。**リリースの本番反映と言葉を分ける。**
 * 同じ「デプロイ失敗」でも、意味が「その版が本番に出ていない」か「出ている版の出し直しに
 * 失敗した」かで、次にやることが違う。成功と待ちは出し直しでも読み方が変わらないため据え置く。
 */
const MANUAL_DEPLOY_STATE_LABEL: Partial<Record<BranchFlowDeployStateKind, string>> = {
  running: "本番へ再デプロイ中",
  failure: "再デプロイ失敗",
};

const MANUAL_DEPLOY_STATE_LABEL_COMPACT: Partial<Record<BranchFlowDeployStateKind, string>> = {
  running: "再デプロイ中",
  failure: "再デプロイ失敗",
};

/**
 * 失敗を自動で再実行した後の文言（#2134）。**手動の出し直しより優先して出す。**
 *
 * 出したいのは「誰かが1回やり直している」ことで、それは押したのが人でも`deploy-retry.yml`でも
 * 変わらない。走っている最中に何も言わないと、人は自分で「本番へ再デプロイ」を押しに行く
 * しかないと読む。失敗まで来たときは逆に、**やり直しても駄目だった＝人が見る番**という意味に
 * なるので、ここだけは押し直しを促さない言い方にする。
 */
const AUTO_RETRIED_DEPLOY_STATE_LABEL: Partial<Record<BranchFlowDeployStateKind, string>> = {
  running: "自動で再デプロイ中",
  failure: "再デプロイしても失敗",
};

const AUTO_RETRIED_DEPLOY_STATE_LABEL_COMPACT: Partial<Record<BranchFlowDeployStateKind, string>> =
  {
    running: "自動で再デプロイ中",
    failure: "再デプロイも失敗",
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

  const label =
    (deploy.autoRetried
      ? (compact ? AUTO_RETRIED_DEPLOY_STATE_LABEL_COMPACT : AUTO_RETRIED_DEPLOY_STATE_LABEL)[
          deploy.kind
        ]
      : undefined) ??
    (deploy.manual
      ? (compact ? MANUAL_DEPLOY_STATE_LABEL_COMPACT : MANUAL_DEPLOY_STATE_LABEL)[deploy.kind]
      : undefined) ??
    (compact ? DEPLOY_STATE_LABEL_COMPACT : DEPLOY_STATE_LABEL)[deploy.kind];
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
 * 手が要るものを探すための画面なのに、開いた先に押せるものが無かった。待てば自動で入るPR
 * （Auto-merge有効・レビュー統合エージェントが自動マージするもの）に出すと、押す必要が
 * 無いものまで押させることになるため、条件はPR一覧と同じ`requiresUserMerge`・
 * `canMergeFromDeck`をそのまま使う（すぐ下の`BumpPullRequestLine`も同じ方針）。
 *
 * **この画面でPRのマージ待ちが見えるのはここだけ**（#2172）。畳んだ1行にも同じ意味のピルを
 * 出していたが、俯瞰する行としては情報量が多いのでやめた。畳んだ行に出ていないことを理由に
 * このバッジ・ボタンまで外すと、ブランチ画面からマージの導線が無くなる。
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
      <MergeJudgementBadge mergeJudgement={pullRequest.mergeJudgement} />
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
  return <AttentionPill>優先度 高</AttentionPill>;
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
 * 人の操作を待っていることを表す琥珀のピル（#2038）。
 *
 * **この画面での琥珀は「あなたの番」を意味する**（リリースのマージ待ち・手作業・優先度 高。
 * 開いたPR行の「ユーザーのマージが必要です」も同じ色）。
 * 同じ意味のバッジが同じ見た目でないと色から読み取れないため、写していたクラスをここへ寄せ、
 * リリースのマージ待ちも合流させた。配色の由来は`pull-request-badges.tsx`の
 * `UserMergeRequiredBadge`（`00.check-user`と同じamber）。
 *
 * 対になるのが紫の`ReleaseProgressPill`で、あちらは「待っていれば次へ進む」。
 */
function AttentionPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
      {children}
    </span>
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
  //
  // **手動の出し直し（#2020）はこの判定に効かせない。** 出し直しはすでに本番へ出たmainを
  // もう一度出しているだけなので、走っている間や失敗したときにこの版の「本番反映」を
  // 取り消すと、出ている版が出ていないように読める。状態そのものはバッジで出す。
  const inProduction =
    group.deploy === null || group.deploy.kind === "success" || group.deploy.manual;
  // **CIが実行中の間は「マージ待ち」と言わない**（#1433と同じ基準）。まだマージできない操作を
  // 人へ促すことになるため、そのあいだは自動で進む「リリース中」のままにする。
  //
  // **CIが落ちているときはここでは「マージ待ち」のまま**——畳んだ1行（`releaseMergeTarget`）が
  // `failure`を除くのは、同じ行に赤の「CI失敗」が並んで意味が競合するからで（#2038）、
  // この見出しには失敗を示すものが無く、外すと止まっているリリースが「リリース中」に見える。
  // 失敗そのものはすぐ下のPRの行（`CiStateBadge`）が出す。
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
                  `${formatMonthDay(group.mergedAt)}に${inProduction ? "本番反映" : "mainへマージ"}`}
              </span>
              {/* 成功は日付の後ろへ回す。「本番反映」を主にし、その裏付けとして添える */}
              {inProduction && <DeployStateBadge deploy={group.deploy} />}
            </>
          ) : waitingUserMerge ? (
            // mainへのマージだけは人が行う。待っているのが人の操作であることを、
            // ヘッダーのリリース状況・スマホの一覧と同じ文言・同じ色で出す（#1579）
            <AttentionPill>{releaseMergeTargetLabel("main")}</AttentionPill>
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
  deployTriggerPending,
  onShowAllVersions,
  onToggleAllPlannedIssues,
  onReleaseTriggered,
  onDeployTriggered,
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
  /** すでに起動済みで、デプロイの実行が現れるのを待っている最中か（#2020） */
  deployTriggerPending: boolean;
  onShowAllVersions: () => void;
  onToggleAllPlannedIssues: () => void;
  /** リリースworkflowを起こせた後（起動中の記録と、バンプPRを出すための取り直し） */
  onReleaseTriggered: () => void;
  /** 本番デプロイworkflowを起こせた後（起動中の記録と、実行を出すための取り直し。#2020） */
  onDeployTriggered: () => void;
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
  // いちばん新しく本番へ出た版がmainへ入った時刻（#2020）。再デプロイの確認ダイアログで
  // 「いま本番に出ているもの」を示すのに使う。束は新しい順なので先頭から最初の1件でよい。
  const latestReleaseMergedAt =
    repository.releaseGroups.find((group) => group.mergedAt !== null)?.mergedAt ?? null;
  const pendingIssues = (repository.releaseGroups[0]?.mergedAt === null
    ? repository.releaseGroups[0].lanes
    : []
  ).flatMap((lane) => (lane.issue ? [lane.issue] : []));

  return (
    <div className="relative px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-xs text-muted-foreground">
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
        {/* **リリースの束ではなくこの行に置く**（#2020）。束は畳まれたり本番反映済みで
            隠れたりするため、束に付けると押したいときに画面から消える。ここなら
            リポジトリを開いている間はつねに同じ位置にある */}
        {repository.canTriggerDeploy && (
          <>
            <span className="flex-1" />
            <RepositoryDeployButton
              repositoryFullName={repository.repositoryFullName}
              currentVersion={repository.release.latestVersion}
              deployedAt={latestReleaseMergedAt}
              unreleasedCommits={unreleasedCommits ?? 0}
              isPending={deployTriggerPending}
              onTriggered={onDeployTriggered}
            />
          </>
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
  showSelectionMarker = false,
  onToggle,
}: {
  repository: BranchFlowRepository;
  branchesFailed: boolean;
  mergedPullRequestsLoaded: boolean;
  /** この端末からリリースworkflowを起こした直後で、まだバンプPRが現れていない（#1955） */
  releaseTriggerPending: boolean;
  isOpen: boolean;
  /**
   * 2ペイン表示で「いま右に出ているのはこの行」を示す縦棒を出すか（#2157）。
   *
   * 中身が行の下に無いぶん、背景色の差だけでは選択中の行を見失う。
   */
  showSelectionMarker?: boolean;
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
      // 2ペインでは中身が行の下に無いので、どこが開いたのかを読み上げへ伝える（#2157）
      aria-controls={showSelectionMarker ? DETAIL_PANE_ID : undefined}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-left hover:bg-accent/50",
        isOpen && "bg-muted/60",
        // 枠線のぶん左padding を詰めて、選択中でない行と文字の位置を揃える
        showSelectionMarker && "border-l-2 border-l-transparent pl-3.5",
        showSelectionMarker && isOpen && "border-l-primary",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform",
          // 2ペインでは下へ伸びないので回さない（回すと下に何か出ると読める）
          isOpen && !showSelectionMarker && "rotate-90",
          isOpen && showSelectionMarker && "text-foreground",
        )}
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
        // 人が押す番になったら紫（自動で進む）から琥珀（手が要る）へ変える（#2038）。
        // 回るアイコンの有無だけが手掛かりだったころは、一覧を流し見して自分の番の
        // リポジトリを見つけられなかった。文言は展開したときの見出しと同じものを使う
        summary.releaseMergeTarget ? (
          <AttentionPill>{releaseMergeTargetLabel(summary.releaseMergeTarget)}</AttentionPill>
        ) : (
          <ReleaseProgressPill
            label="リリース中"
            spinning={summary.releaseCiPending}
            note="チェック実行中"
          />
        )
      ) : (
        // 起動からバンプPRが現れるまでは、開いたときのボタン（「リリース起動中…」）にしか
        // 出ていなかった（#1955）。バンプPRが現れれば上の「リリース中」へ引き継がれる
        releaseLaunching && (
          <ReleaseProgressPill label="リリース起動中" spinning note="workflowの起動待ち" />
        )
      )}
      {/* マージ後もデプロイが終わるまでは本番へ出ていない。開かなくても分かるようにする（#1579） */}
      <DeployStateBadge deploy={deploy} compact linkToRun={false} />

      {/* **PRのマージ待ちは畳んだ行に出さない**（#2172）。8リポジトリを1行ずつ並べる画面で
          ピルが長く、スマホ幅ではその行だけが2段に折り返していた。マージの導線は開いたPR行
          （`PullRequestLine`）とPR一覧画面が持っているので、畳んだままでも操作は失われない。
          ヘッダーの「手が要るもの◯件」には引き続き数える（`needsAttention`）。
          リリースPRのマージ待ち（「mainへマージ待ち」）は上の琥珀のピルが表す（#2038） */}
      {/* 手作業は畳んだ束にも残る（#1586）。開かなくても残っていることが分かるようにする */}
      {summary.openManualStepCount > 0 && (
        <AttentionPill>手作業{summary.openManualStepCount}</AttentionPill>
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
  selectionMode = false,
  detailHost = null,
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
  /** 2ペイン表示か（#2157）。行の見た目（選択の縦棒）と中身の行き先が変わる */
  selectionMode?: boolean;
  /**
   * 開いた中身（流れ図）を描く先（#2157）。2ペイン表示では右ペインの要素を渡し、
   * `null`なら従来どおり行の下へ差し込む。
   *
   * **右ペインを別のコンポーネントにせず、描画先だけを差し替えるのが要点。** 行と中身を
   * 別々に組み立てると`useTriggerPending`（起動中）を2か所から呼ぶことになり、押した瞬間の
   * 書き込みが互いに伝わらない状態が戻ってくる（#1955でわざわざ1か所へまとめた）。
   */
  detailHost?: HTMLElement | null;
  onToggle: () => void;
  onShowAllVersions: () => void;
  onToggleAllPlannedIssues: () => void;
  /** リリースworkflowを起こした後の取り直し */
  onRefresh: () => void;
  onMerged: (pullRequest: PullRequestSummary) => void;
}) {
  const { isPending, markTriggered } = useTriggerPending("release", repository.repositoryFullName);
  const deployTrigger = useTriggerPending("deploy", repository.repositoryFullName);

  const graph = (
    <ReleaseFlowGraph
      repository={repository}
      showClosed={showClosed}
      showAllVersions={showAllVersions}
      showAllPlannedIssues={showAllPlannedIssues}
      mergedPullRequestsLoaded={mergedPullRequestsLoaded}
      releaseTriggerPending={isPending}
      deployTriggerPending={deployTrigger.isPending}
      onShowAllVersions={onShowAllVersions}
      onToggleAllPlannedIssues={onToggleAllPlannedIssues}
      onReleaseTriggered={() => {
        markTriggered();
        onRefresh();
      }}
      onDeployTriggered={() => {
        deployTrigger.markTriggered();
        onRefresh();
      }}
      onMerged={onMerged}
    />
  );

  return (
    <section>
      <RepositorySummaryRow
        repository={repository}
        branchesFailed={branchesFailed}
        mergedPullRequestsLoaded={mergedPullRequestsLoaded}
        releaseTriggerPending={isPending}
        isOpen={isOpen}
        showSelectionMarker={selectionMode}
        onToggle={onToggle}
      />
      {/* 2ペインでは右ペインへ送る（#2157）。描画先がまだ無い一瞬は何も出さない——
          行の下へ落とすと、切り替わる前に一覧が縦へ伸びて見える */}
      {isOpen &&
        (selectionMode
          ? detailHost && createPortal(graph, detailHost)
          : <div className="border-b">{graph}</div>)}
    </section>
  );
}

/**
 * 手を動かす必要があるリポジトリか。ヘッダーの「手が要るもの◯件」に数える（#1510）。
 *
 * **開く条件ではない**（#1932）。初回に自動で開く動きはやめたので、この判定が変える表示は
 * ヘッダーの件数だけで、開くかどうかはユーザーが決める。
 *
 * **リリース中・デプロイ中は、人が押す番になったときだけ数える**（#2038）。#1510・#1579では
 * リリースが動いていること自体を数えていたが、そのせいで「手が要るもの6件」の中身がCIの完了を
 * 待つだけのものばかりになり、件数を見ても押す番かどうかが分からなかった。自動で進んでいる
 * ぶんは`isProgressing`が「待てば進むもの◯件」として同じヘッダーに残すので、mainへマージして
 * から本番へ出るまでを見に来る手掛かり（#1579）は消えない。
 *
 * **「リリース起動中」（#1955）だけはどちらにも含めない。** 押す操作の有無ではなく、判断の材料が
 * 端末ローカルの記録（起動時刻をlocalStorageへ置き、10分で失効する）でしかないため——
 * 数えると、同じ画面をどの端末で見るかによってヘッダーの件数が食い違う。畳んだ行のピルは
 * 押した端末にだけ出るもので、そこで閉じている。
 */
function needsAttention(repository: BranchFlowRepository): boolean {
  const { summary } = repository;
  return (
    summary.hasCiFailure ||
    summary.needsUserMerge ||
    summary.releaseMergeTarget !== null ||
    summary.deploy?.kind === "failure"
  );
}

/**
 * 待っていれば次へ進むリポジトリか。ヘッダーの「待てば進むもの◯件」に数える（#2038）。
 *
 * **「手が要るもの」と重ねて数えない**（呼び出し側で`needsAttention`を除く）。同じリポジトリが
 * 両方に出ると、2つの件数を足しても画面に並ぶ行数と合わなくなる。
 *
 * **畳んだ1行の「進行中 N件」とは別物。** あちらは作業レーンの本数（`activeLaneCount`）で、
 * こちらはリポジトリの件数。同じ画面で同じ言葉が2つの意味を持たないよう、言い回しを分けている。
 */
function isProgressing(repository: BranchFlowRepository): boolean {
  const { summary } = repository;
  const deploying =
    summary.deploy !== null &&
    summary.deploy.kind !== "success" &&
    summary.deploy.kind !== "failure";
  return (summary.releaseInProgress && summary.releaseMergeTarget === null) || deploying;
}

/**
 * 2ペイン表示の右ペインの見出し（#2157）。
 *
 * **どのリポジトリを見ているかを、左の一覧をたどらずに分かるようにするためだけのもの。**
 * 状態のバッジは畳んだ1行と流れ図の両方が持っているので重ねず、ここには一覧の行では
 * `owner/`を落としているフル名と、開いたときに毎回目で追う数（未リリース・進行中）を置く。
 */
function RepositoryDetailHeader({ repository }: { repository: BranchFlowRepository }) {
  const unreleasedCommits = repository.release.comparison?.aheadBy ?? 0;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: getRepoColor(repository.repositoryFullName) }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold">{repository.repositoryFullName}</h2>
        <p className="truncate text-xs text-muted-foreground">
          {repository.release.latestVersion ? (
            <span>v{repository.release.latestVersion}</span>
          ) : (
            <span>リリース済みのバージョンなし</span>
          )}
          {unreleasedCommits > 0 && <span>{` ・ 未リリース ${unreleasedCommits}コミット`}</span>}
          {repository.summary.activeLaneCount > 0 && (
            <span>{` ・ 進行中 ${repository.summary.activeLaneCount}件`}</span>
          )}
        </p>
      </div>
      {repository.repositoryPrivate && (
        <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
      )}
      {/* アプリ内にリポジトリそのものの画面は無いので別タブで開く */}
      <a
        href={`https://github.com/${repository.repositoryFullName}`}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="GitHubでリポジトリを開く"
        aria-label="GitHubでリポジトリを開く"
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
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
 * **PCで幅が足りるときは左右2ペインに分ける**（#2157。`splitLayout`）。左は畳んだ1行の一覧の
 * まま、選んだ1件の流れ図を右ペインへ出す。1カラムのまま下へ展開すると、横幅が余っているのに
 * 縦へ伸び、一覧と中身を同時に見られなかった。スマホと幅が足りないPCは従来どおり。
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
  deployAutoRefreshIntervalMs = null,
  onChangeAutoRefreshInterval,
  onRefresh,
  onMerged,
  onPullToRefresh,
  refreshIconOnly = false,
  splitLayout = false,
  headerLeading,
  headerActions,
  className,
  style,
  footerSpacing = false,
}: BranchFlowViewProps) {
  // 2ペイン表示（#2157）。分けるかどうかは実測した幅で決める（`SPLIT_MIN_WIDTH`）
  const layoutRef = useRef<HTMLDivElement>(null);
  const isWideEnough = useIsWiderThan(layoutRef, SPLIT_MIN_WIDTH);
  const isSplit = splitLayout && isWideEnough;
  // 右ペインの中身の描画先。コールバックrefは同一の関数にしておく（毎回新しい関数を渡すと
  // Reactが付け外しを繰り返し、そのたびに状態が変わって再描画が止まらなくなる）
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);
  const handleDetailHostRef = useCallback((node: HTMLDivElement | null) => setDetailHost(node), []);
  const listWidth = useResizableWidth(LIST_PANE_WIDTH);
  // 右に出しているリポジトリ。端末ごとに覚える（開き直しても同じものを見ている状態から始める）。
  //
  // **URLへは持たない。** PR一覧・Issue一覧の2カラムは選択をURL（`pr`・`issue`）に置くが、
  // あちらは通知や本文中の参照から特定の1件を開く経路があるためで、この画面には無い。
  // 代わりに左メニューの選択（URLの`repos`）が既に「どのリポジトリを見たいか」を持っており、
  // ここへ`flowrepo`のようなキーを足すと同じことを表すものがURLに2つ並ぶ。`repos`は
  // 「選択が変わった瞬間にその先頭を右へ出す」きっかけとしてだけ効かせる（下のeffect）。
  const [selectedRepositoryFullName, setSelectedRepositoryFullName] = usePersistedState<
    string | null
  >("issue-deck:branch-flow-selected-repository", null);

  const [openRepositories, setOpenRepositories] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  const [allVersionsRepositories, setAllVersionsRepositories] = useState<Set<string>>(new Set());
  // 実装予定を全件出しているリポジトリ（#1704）。既定は頭出しの3件までで、押すたびに切り替える
  const [allPlannedRepositories, setAllPlannedRepositories] = useState<Set<string>>(new Set());
  const attentionRepositories = flow.repositories.filter(needsAttention);
  // 手が要るものに数えたリポジトリは除く（#2038）。同じ行を2つの件数へ二重に数えない
  const progressingRepositories = flow.repositories.filter(
    (repository) => !needsAttention(repository) && isProgressing(repository),
  );

  // 引っ張って更新（#1958）。タッチを受けるのはスクロール領域を包む枠で、スクロール位置は
  // 中のスクロール領域から見る（Issue一覧＝`issue-list.tsx`と同じ組み方）。
  // 取得の完了は`isRefreshing`で待つ——`onRefresh`（`use-branch-flow.ts`・`use-pull-requests.ts`の
  // `refresh`）は取り直しのきっかけを作る同期関数で、待っても取得の完了とは無関係に返る
  const pullContainerRef = useRef<HTMLDivElement>(null);
  const pullScrollRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    containerRef: pullContainerRef,
    scrollRef: pullScrollRef,
    onRefresh: onPullToRefresh,
    isRefreshing: isRefreshing ?? isLoading,
  });

  // **取得に失敗したときは読み込み中で止めない**（#1711）。`error`は見出しのすぐ下に出ており、
  // そこへ終わらない「読み込み中」を重ねると、待てば直るものとして読めてしまう。
  // 失敗しているときは従来どおりの表示（＝取れた範囲で描く）に戻す。
  const releasesLoaded = mergedPullRequestsLoaded || error !== null;

  // **手が要るリポジトリを初回に自動で開くのはやめた**（#1932）。#1510・#1711では
  // CI失敗・マージ待ち・リリース中のリポジトリを開いた直後に展開していたが、そのぶん
  // 初期表示が縦に伸び、全リポジトリを1行に畳んで俯瞰する画面の趣旨と食い違っていた。
  // 手が要ることはヘッダーの「手が要るもの◯件」と畳んだ行のバッジが伝えるので、
  // 開くかどうかはユーザーが決める（行のクリック・「すべて開く」）。
  // **ただしPRのマージ待ちは畳んだ行に出さない**（#2172）ので、件数に数えたぶんの一部は
  // 行から探せない。どのリポジトリかは左メニューの「ユーザーの確認待ち」・PR一覧の
  // 「マージ待ち」で特定できる。

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
    // 2ペインでは同時に1件しか出せないので、先頭の1件を右へ出す（#2157）
    setSelectedRepositoryFullName(names[0]);
  }, [expandedKey, setSelectedRepositoryFullName]);

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

  // 2ペインでは押すたびに畳まず、押した行を右へ出す（#2157）。同じ行をもう一度押しても
  // 閉じない——右ペインが空になるだけで、得るものが無い
  function handleRowClick(fullName: string) {
    if (isSplit) setSelectedRepositoryFullName(fullName);
    else toggleRepository(fullName);
  }

  function isRepositoryOpen(fullName: string) {
    return isSplit ? selectedRepositoryFullName === fullName : openRepositories.has(fullName);
  }

  const allOpen =
    flow.repositories.length > 0 && openRepositories.size === flow.repositories.length;
  // 覚えている選択が今の一覧に無い（非表示にした・まだ読み込めていない）こともある
  const selectedRepository =
    flow.repositories.find(
      (repository) => repository.repositoryFullName === selectedRepositoryFullName,
    ) ?? null;

  return (
    <div ref={layoutRef} className={cn("flex flex-col overflow-hidden", className)} style={style}>
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
                  出さないと「リポジトリを選んだのに件数が減らない」ようにしか見えない。
                  **2ペインでは同時に1件しか出せないので言い方を変える**（#2157）。
                  「◯件を展開」のままだと、選んだ数と右に出ているものが食い違う */}
              {expandedRepositoryFullNames.length > 0 && (
                <span>
                  {isSplit
                    ? " ・ 絞り込み中の先頭を表示"
                    : ` ・ 絞り込み中の${expandedRepositoryFullNames.length}件を展開`}
                </span>
              )}
              {attentionRepositories.length > 0 && (
                <span>{` ・ 手が要るもの${attentionRepositories.length}件`}</span>
              )}
              {/* 自動で進んでいるぶんは別に数える（#2038）。「手が要るもの」へ混ぜていたころは、
                  件数を見ても押す番があるのかが分からなかった */}
              {progressingRepositories.length > 0 && (
                <span>{` ・ 待てば進むもの${progressingRepositories.length}件`}</span>
              )}
              {fetchedAt && <span>{` ・ ${formatTimeOfDay(fetchedAt)}時点`}</span>}
              {/* 何分間隔で更新中なのかを画面に出す（#1767）。更新アイコンが回っているだけでは
                  「いま取りに行った」ことしか分からず、次にいつ更新されるかが読めない。
                  **自動更新していないときも黙らない**（#1797。文言はPR一覧・Issue一覧と共通） */}
              <span>{` ・ ${describeAutoRefreshState(autoRefreshIntervalMs)}`}</span>
              {/* 本番デプロイが動いている間だけ回っているぶん（#1797）。「手動更新のみ」と
                  出ている裏でデプロイの表示だけが進むため、その1点だけを添える */}
              {deployAutoRefreshIntervalMs !== null && (
                <span>{` ・ デプロイ中は${autoRefreshIntervalLabel(deployAutoRefreshIntervalMs)}で確認`}</span>
              )}
            </p>
          </div>
          {/* 見出しと同じ段に置く（#1638）。実行状況はどの画面でも1段目の右端で揃える */}
          {headerActions}
        </div>
        {/* 2ペインでは同時に1件しか出せないので出さない（#2157） */}
        {!isSplit && (
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
        )}
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
            /* アイコンだけにしても読み上げ用の名前は「更新」のまま（#1958） */
            aria-label="更新"
            /* 押すと何が起きるかと、放っておいても更新されるのかの両方を出す（#1797）。
               通知ベル・実行キューの更新インジケーターと同じ文言 */
            title={describeRefreshButtonHint(autoRefreshIntervalMs)}
            className={cn(
              "h-8 shrink-0",
              refreshIconOnly && "px-2",
              onChangeAutoRefreshInterval && "rounded-r-none pr-1.5",
            )}
            disabled={isLoading}
            onClick={onRefresh}
          >
            {/* 回転させる条件は`isRefreshing`（自動更新でも回る。#1767）。ボタンを押せなく
                するのは手動更新のときだけなので、こちらは`isLoading`のまま */}
            <RefreshCw className={cn("size-3.5", (isRefreshing ?? isLoading) && "animate-spin")} />
            {/* スマホは引っ張って更新できるぶん文字を出さない（#1958） */}
            {!refreshIconOnly && "更新"}
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

      {/* 引っ張って更新（#1958）のタッチを受ける枠。スクロールするのは中の要素で、
          この枠は動かさない（インジケーターを上端に重ねる基準にもなる） */}
      <div
        ref={pullContainerRef}
        className={cn("relative flex min-h-0 flex-1", isSplit ? "flex-row" : "flex-col")}
      >
        <PullToRefreshIndicator pull={pull} />

        <div
          ref={pullScrollRef}
          className={cn(
            "overflow-y-auto overscroll-contain",
            isSplit ? "shrink-0 border-r" : "flex-1",
          )}
          style={{
            width: isSplit ? listWidth.width : undefined,
            transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
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
              isOpen={isRepositoryOpen(repository.repositoryFullName)}
              selectionMode={isSplit}
              detailHost={detailHost}
              onToggle={() => handleRowClick(repository.repositoryFullName)}
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

        {/* 右ペイン（#2157）。中身は`RepositorySection`がここへ送り込む */}
        {isSplit && (
          <>
            <ResizeHandle onDragStart={listWidth.handleDragStart} className="block" />
            <div id={DETAIL_PANE_ID} className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {selectedRepository ? (
                <>
                  <RepositoryDetailHeader repository={selectedRepository} />
                  <div ref={handleDetailHostRef} className="min-h-0 flex-1 overflow-y-auto" />
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <GitBranch className="size-6 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">
                    左の一覧からリポジトリを選ぶと、ここに流れを表示します。
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
