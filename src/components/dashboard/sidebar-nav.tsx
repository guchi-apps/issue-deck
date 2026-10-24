"use client";

import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import {
  Archive,
  CalendarClock,
  CircleSlash,
  ChevronDown,
  Eye,
  EyeOff,
  FolderGit2,
  Gauge,
  GitBranch,
  History,
  Lightbulb,
  Smartphone,
  Loader2,
  Lock,
  MonitorPlay,
  Plus,
  Settings2,
  Star,
  TerminalSquare,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { NavCount, type NavCountEmphasis } from "@/components/dashboard/nav-count";
import { useNotificationState } from "@/components/dashboard/notification-state";
import type { DashboardPane } from "@/hooks/use-issue-filters";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import {
  describeMergePendingAttention,
  isPullRequestViewAttention,
  type MergePendingAttention,
} from "@/lib/merge-pending-attention";
import { resolveQuestionNavSignals } from "@/lib/question-attention";
import {
  getNavViewPcLabel,
  navViewIcons,
  sidebarAttentionNavViews,
  sidebarCodeReviewNavViews,
  PREVIEW_NAV_VISIBLE,
} from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { getPullRequestView, pullRequestViewIcons } from "@/lib/pull-request-views";
import { describeReleaseActivity, type ReleaseActivityCounts } from "@/lib/release-activity";
import { getRepoColor } from "@/lib/repo-color";
import {
  isRepositoryAutomationUnsupported,
  REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE,
} from "@/lib/repository-automation";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type SidebarNavProps = {
  activeView: NavViewId;
  onSelectView: (view: NavViewId) => void;
  /** 中央カラムに表示中のペイン。Issueビューの選択状態はIssueペインのときだけ表示する */
  activePane: DashboardPane;
  /** PRペインで表示中の状態別ビュー（#1312） */
  activePullRequestView: PullRequestViewId;
  onSelectPullRequestView: (view: PullRequestViewId) => void;
  /** 「ブランチ」画面を開く（#1455） */
  onSelectFlow: () => void;
  /** 確認環境（#2444）の画面を開く */
  onSelectPreview: () => void;
  /**
   * いま確認環境が動いているか（#2444）。**動いている間だけ行に緑の点を出す。**
   * 押し忘れて置きっぱなしになっているのを、他の画面を見ている間にも気付けるようにする
   * （自動停止はするが、それまでサブPCのメモリを占める）。
   */
  previewRunning?: boolean;
  /** AI使用量（#2504）の画面を開く */
  onSelectUsage: () => void;
  /** リリース履歴（#2726）の画面を開く */
  onSelectReleaseHistory: () => void;
  /** 予約実行（#2995）の画面を開く */
  onSelectNightlyRun: () => void;
  /** 新規アプリの構想一覧を開く */
  onSelectIdeas?: () => void;
  /** リモートセッション（#4743）の画面を開く */
  onSelectRemoteSessions?: () => void;
  /** iOS拡張（#3708）の画面を開く */
  onSelectIosExtensions?: () => void;
  /** 次の5時間枠に積んであるIssueの数（#2995）。行に出す。nullなら出さない */
  nightlyRunQueuedCount?: number | null;
  /** 構想の件数（#3639）。取得できていないときはnullで、何も出さない */
  ideasCount?: number | null;
  /**
   * リモートセッションの起動数（#4948。起動中＋稼働中）。取得できていないときはnullで、何も出さない。
   * `remoteSessionStarting`はURL待ちの1本があるときに回転アイコンを出す
   */
  remoteSessionCount?: number | null;
  remoteSessionStarting?: boolean;
  /**
   * いま表示中の画面がリポジトリの絞り込みを適用するか（#4543）。質問・確認待ち・ブランチ等の
   * 適用外の画面では、選択が残っていても効いていないことを注記する。
   */
  repoFilterApplies?: boolean;
  navCounts: Record<NavViewId, number>;
  /**
   * 「ユーザーの確認待ち」へ一緒に出す、ユーザーのマージ待ちPRの件数（#1613）。
   * 対応Issueが同じ一覧に並ぶPRは含まない（`pullRequestsAwaitingUserMerge`）。
   */
  checkUserPullRequestCount: number;
  /** 「ユーザーの作業待ち」の内訳（#1613）。いま実行できるものがあるときだけ強調する */
  manualStepAttention: ManualStepAttention;
  /**
   * 未確認（回答が届いていて未読）の質問の件数（#2070）。**行に出す数字は`navCounts`から
   * 引き、これは使わない**——オレンジの丸を点けるかどうかと、吹き出しの内訳だけに使う。
   */
  unconfirmedQuestionCount: number;
  /**
   * 回答待ち（質問を投げてまだ回答が届いていない）の質問の件数（#2309）。**「質問」の行の
   * スピナーを回すかどうかと、吹き出しの内訳に使う。行に出す数字はこれまでどおり`navCounts`。**
   */
  waitingQuestionCount: number;
  /**
   * リリース・デプロイが動いているリポジトリ数（#2167）。「ブランチ」行の件数とオレンジの丸に
   * 使う。**nullは未取得**で、そのときは件数を出さない（0を出すと「動いているものが無い」と
   * 読めてしまう）。
   */
  releaseActivity: ReleaseActivityCounts | null;
  /**
   * 「確認を追う対象」に選んだリポジトリの、未確認のリリース件数（#2951）。「リリース履歴」行の
   * 件数とオレンジの丸に使う。**nullは未取得**で、そのときは件数を出さない。
   */
  releaseUncheckedCount: number | null;
  /** PRビューごとの件数（#1389）。nullのビューは件数を出さない */
  pullRequestNavCounts: PullRequestNavCounts;
  /**
   * 「マージ待ち」の内訳（#2334）。**行に出す数字は`pullRequestNavCounts`から引き、これは
   * 使わない**——オレンジの丸を点けるかどうかと、吹き出しの内訳だけに使う。**nullは未取得。**
   */
  mergePendingAttention: MergePendingAttention | null;
  repositories: ConnectedRepository[];
  selectedRepoFullNames?: string[];
  onSelectRepository?: (repository: ConnectedRepository) => void;
  onClearRepository?: () => void;
  onHideRepository?: (repository: ConnectedRepository) => void;
  onShowRepository?: (repository: ConnectedRepository) => void;
  onSetRepositoryFavorite?: (repository: ConnectedRepository, favorite: boolean) => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * PCの左メニュー（#742ほか）。
 *
 * **「ブランチ」「リリース履歴」行の件数はProviderから自分で読む**（#2167・#2951。
 * `MobileBottomNav`と同じ形）。前者は専用のポーリング（`/api/repositories/release-pending-merges`）を
 * `NotificationProvider`が持つ。後者も同様の常時ポーリング（`/api/repositories/release-history/unchecked-count`）
 * を持つが、**「リリース履歴」画面を開いて取得済みのあいだはそちらの値を優先する**
 * （`issue-deck-shell.tsx`が`releaseHistoryUncheckedCountOverride`として渡す。「確認済みにする」を
 * 押した直後、ポーリングだと反映が最大5分遅れるため）。`issue-deck-shell.tsx`は
 * `NotificationProvider`の親なのでフックを呼べず、propで配れない。**ここで新しく同じフックを
 * 呼ぶと取得が2本走る。**
 */
export function SidebarNav(
  props: Omit<SidebarNavProps, "releaseActivity" | "releaseUncheckedCount">,
) {
  const { releaseActivity, releaseUncheckedCount } = useNotificationState();

  return (
    <SidebarNavView
      {...props}
      releaseActivity={releaseActivity}
      releaseUncheckedCount={releaseUncheckedCount}
    />
  );
}

/**
 * 描画だけを持つ本体。Providerに依存しないので、件数を渡してそのまま試験できる。
 */
export function SidebarNavView({
  activeView,
  onSelectView,
  activePane,
  activePullRequestView,
  onSelectPullRequestView,
  onSelectFlow,
  onSelectPreview,
  previewRunning = false,
  onSelectUsage,
  onSelectReleaseHistory,
  onSelectNightlyRun,
  onSelectIdeas = () => {},
  onSelectRemoteSessions = () => {},
  onSelectIosExtensions = () => {},
  nightlyRunQueuedCount = null,
  ideasCount = null,
  remoteSessionCount = null,
  remoteSessionStarting = false,
  repoFilterApplies = true,
  navCounts,
  checkUserPullRequestCount,
  manualStepAttention,
  unconfirmedQuestionCount,
  waitingQuestionCount,
  releaseActivity,
  releaseUncheckedCount,
  pullRequestNavCounts,
  mergePendingAttention,
  repositories,
  selectedRepoFullNames = [],
  onSelectRepository,
  onClearRepository,
  onHideRepository,
  onShowRepository,
  onSetRepositoryFavorite,
  className,
  style,
}: SidebarNavProps) {
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
  const [isEditingRepoVisibility, setIsEditingRepoVisibility] = useState(false);
  const [isRepoFilterOpen, setIsRepoFilterOpen] = useState(false);
  const hiddenRepoCount = repositories.filter((repo) => repo.hidden).length;
  // 「すべて表示する（N）」のNは、いま実際に隠れている件数にする。選択中のリポジトリは
  // 非表示でも一覧に出すため、hiddenの総数のままだと押しても増えない件数を出してしまう。
  const collapsedRepoCount = repositories.filter(
    (repo) => repo.hidden && !selectedRepoFullNames.includes(repo.fullName),
  ).length;
  // 選択中のリポジトリは非表示にしていても出す。行が消えると選択だけが残り、その行から
  // 解除できなくなるため（#1480）。
  const visibleRepositories = showHiddenRepos
    ? repositories
    : repositories.filter((repo) => !repo.hidden || selectedRepoFullNames.includes(repo.fullName));
  // 選択中のリポジトリを一覧の先頭へ寄せる（#1480）。連携数が増えると選択中の行が
  // スクロール範囲の外へ出て、どれで絞り込んでいるかが分からなくなるため。グループ内の
  // 並び（fullNameの昇順）は元のまま保ち、選択が0件なら並びは今までと変わらない。
  const selectedRepositories = visibleRepositories.filter((repo) =>
    selectedRepoFullNames.includes(repo.fullName),
  );
  const unselectedRepositories = visibleRepositories.filter(
    (repo) => !selectedRepoFullNames.includes(repo.fullName),
  );
  const orderedRepositories = [...selectedRepositories, ...unselectedRepositories];
  const showSelectedRepoSeparator =
    selectedRepositories.length > 0 && unselectedRepositories.length > 0;

  // 閉じている間も、何で絞っているかを読める1行（#4543）
  const repoFilterSummary =
    selectedRepoFullNames.length === 0
      ? "すべてのリポジトリ"
      : selectedRepoFullNames.length === 1
        ? (repositories.find((repo) => repo.fullName === selectedRepoFullNames[0])?.name ??
          selectedRepoFullNames[0])
        : `${selectedRepoFullNames.length}件のリポジトリ`;

  // ユーザーの確認待ちには、対応Issueを持たないマージ待ちPR（develop→mainのリリースPRなど）も
  // 数に含める（#1613）。一覧側も同じ集合を先頭に出す。
  const checkUserCount = navCounts["check-user"] + checkUserPullRequestCount;

  /** 要対応・Issue・PRで見た目を揃えるための1行 */
  function navRow({
    key,
    label,
    icon: Icon,
    active,
    onClick,
    count,
    emphasis = "none",
    busy = false,
    title,
  }: {
    key: string;
    label: string;
    icon: LucideIcon;
    active: boolean;
    onClick: () => void;
    /** nullなら件数を出さない */
    count?: number | null;
    /** 件数の強調（`NavCount`。塗りつぶしの丸は人が動くまで進まないものだけ） */
    emphasis?: NavCountEmphasis;
    /**
     * その行の先で何かが処理中か（#2309）。ラベルの右に回るアイコンを出す。
     *
     * **オレンジの丸（`emphasis`）と役割が違う。** 丸は人が動くまで進まないもの、これは
     * 人が何もしなくても進むものを表す。同じ行に両方出ることがあり（回答待ちの質問と、
     * 読んでいない回答が同居する）、それぞれ別の行為を促すので片方へ寄せない。
     */
    busy?: boolean;
    title?: string;
  }) {
    return (
      <li key={key}>
        <button
          type="button"
          onClick={onClick}
          title={title}
          className={cn(
            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
            active && "bg-accent font-medium",
          )}
        >
          <span className="flex items-center gap-2">
            <Icon className="size-3.5 text-muted-foreground" />
            {label}
            {busy && <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />}
          </span>
          {/* 強調の使い分けと見た目は`NavCount`（スマホのホームと共通） */}
          <NavCount count={count} emphasis={emphasis} />
        </button>
      </li>
    );
  }

  /** 状態別のIssueビューの行。表示名は「対象：状態」のPC用（#4543） */
  function issueViewRow(id: NavViewId) {
    return navRow({
      key: id,
      label: getNavViewPcLabel(id),
      icon: navViewIcons[id],
      active: activeView === id && activePane === "issues",
      onClick: () => onSelectView(id),
      count: navCounts[id],
    });
  }

  /** PCの状態別PRビューの行。件数・強調・吹き出しは従来どおり */
  function pullRequestRow(id: PullRequestViewId) {
    const view = getPullRequestView(id);
    return navRow({
      key: `pr-${id}`,
      label: view.pcLabel,
      icon: pullRequestViewIcons[id],
      active: activePane === "pull-requests" && activePullRequestView === id,
      onClick: () => onSelectPullRequestView(id),
      count: pullRequestNavCounts[id],
      // 「マージ待ち」のうち人が手を動かすまで進まないものが残っているときだけオレンジの丸（#2334）
      emphasis: isPullRequestViewAttention(id, mergePendingAttention) ? "attention" : "none",
      title:
        id === "completed"
          ? describeMergePendingAttention(view.description, mergePendingAttention)
          : view.description,
    });
  }

  /** 質問・コードレビューの行。合図（丸・回るアイコン・吹き出し）は行ごとに決める（#2325） */
  function questionSignalRow(id: NavViewId) {
    const signals = resolveQuestionNavSignals(id, {
      total: navCounts.question,
      unconfirmed: unconfirmedQuestionCount,
      waiting: waitingQuestionCount,
    });
    return navRow({
      key: id,
      label: getNavViewPcLabel(id),
      icon: navViewIcons[id],
      active: activeView === id && activePane === "issues",
      onClick: () => onSelectView(id),
      count: navCounts[id],
      emphasis: signals.attention ? "attention" : "none",
      busy: signals.busy,
      title: signals.title,
    });
  }

  return (
    <nav className={cn("flex flex-col gap-4 overflow-y-auto p-4", className)} style={style}>
      {/* リポジトリで絞り込み（#4543）。4工程より上に置き、初期表示は閉じる。閉じていても
          選択名・件数と解除を出し、効かない画面では全リポジトリ表示であることを示す */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsRepoFilterOpen((prev) => !prev)}
            aria-expanded={isRepoFilterOpen}
            aria-controls="sidebar-repo-filter"
            title="リポジトリで絞り込み"
            aria-label={`リポジトリで絞り込み（${repoFilterSummary}）`}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{repoFilterSummary}</span>
            </span>
            <ChevronDown
              className={cn("size-3.5 shrink-0 text-muted-foreground", isRepoFilterOpen && "rotate-180")}
            />
          </button>
          {selectedRepoFullNames.length > 0 && (
            <button
              type="button"
              onClick={() => onClearRepository?.()}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="リポジトリの選択を解除"
              aria-label="リポジトリの選択を解除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {selectedRepoFullNames.length > 0 && !repoFilterApplies && (
          <p className="px-2 text-[11px] text-muted-foreground">
            この画面は全リポジトリを表示中です（絞り込みは適用されません）
          </p>
        )}
        {isRepoFilterOpen && (
          <div id="sidebar-repo-filter" className="rounded-md border p-2">
            <div className="mb-1 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setIsEditingRepoVisibility((prev) => !prev)}
                title={
                  isEditingRepoVisibility
                    ? "表示・非表示や設定の切り替えを終了"
                    : "表示・非表示や設定を切り替える"
                }
                className={cn(
                  "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
                  isEditingRepoVisibility && "bg-accent text-foreground",
                )}
              >
                <Settings2 className="size-3.5" />
              </button>
              <a
                href={getGithubAppInstallUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="GitHub Appをインストールしてリポジトリを追加"
              >
                <Plus className="size-3.5" />
              </a>
            </div>
        {repositories.length === 0 ? (
          <div className="px-2 text-xs text-muted-foreground">
            まだリポジトリと連携していません。
            <a
              href={getGithubAppInstallUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-primary hover:underline"
            >
              GitHub Appをインストール
            </a>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {orderedRepositories.map((repo, index) => {
                const color = getRepoColor(repo.fullName);
                return (
                  <Fragment key={repo.id}>
                    {showSelectedRepoSeparator && index === selectedRepositories.length && (
                      <li aria-hidden="true">
                        <Separator className="my-1" />
                      </li>
                    )}
                    <li className="group/repo flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectRepository?.(repo)}
                        className={cn(
                          "flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                          selectedRepoFullNames.includes(repo.fullName) && "bg-accent font-medium",
                          repo.hidden && "text-muted-foreground",
                        )}
                      >
                        <span className="flex items-center gap-2 truncate">
                          <span
                            className="flex size-5 shrink-0 items-center justify-center rounded"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            <FolderGit2 className="size-3" />
                          </span>
                          <span className="truncate">{repo.name}</span>
                        </span>
                        {(repo.archived || repo.private || isRepositoryAutomationUnsupported(repo)) && (
                          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                            {repo.archived && (
                              <span title="アーカイブ済み">
                                <Archive className="size-3" />
                              </span>
                            )}
                            {repo.private && (
                              <span title="プライベートリポジトリ">
                                <Lock className="size-3" />
                              </span>
                            )}
                            {isRepositoryAutomationUnsupported(repo) && (
                              <span title={REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE}>
                                <CircleSlash className="size-3" />
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSetRepositoryFavorite?.(repo, !repo.favorite)}
                        title={repo.favorite ? "お気に入りから外す" : "お気に入りに追加"}
                        aria-label={repo.favorite ? "お気に入りから外す" : "お気に入りに追加"}
                        className={cn(
                          "shrink-0 rounded-md p-1 hover:bg-accent hover:text-foreground",
                          repo.favorite
                            ? "text-yellow-500 opacity-100"
                            : "text-muted-foreground opacity-0 group-hover/repo:opacity-100",
                        )}
                      >
                        <Star className={cn("size-3.5", repo.favorite && "fill-yellow-400")} />
                      </button>
                      {isEditingRepoVisibility && (
                        <button
                          type="button"
                          onClick={() =>
                            repo.hidden ? onShowRepository?.(repo) : onHideRepository?.(repo)
                          }
                          title={repo.hidden ? "表示する" : "非表示にする"}
                          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {repo.hidden ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </button>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ul>
            {(showHiddenRepos ? hiddenRepoCount > 0 : collapsedRepoCount > 0) && (
              <button
                type="button"
                onClick={() => setShowHiddenRepos((prev) => !prev)}
                className="mt-1 px-2 text-xs text-primary hover:underline"
              >
                {showHiddenRepos
                  ? "非表示のリポジトリを隠す"
                  : `すべて表示する（${collapsedRepoCount}）`}
              </button>
            )}
          </>
        )}
          </div>
        )}
      </div>

      <Separator />

      {/* 一覧（横断）。工程から独立させ、既存の全件ビューを開く */}
      <ul className="flex flex-col gap-0.5">
        {issueViewRow("all")}
        {pullRequestRow("all")}
      </ul>

      {/* 要対応（横断）。確認待ち・作業待ちはIssue/PRや複数工程にまたがるため接頭辞を付けない */}
      <ul className="flex flex-col gap-0.5">
        {sidebarAttentionNavViews.map((view) =>
          navRow({
            key: view.id,
            label: getNavViewPcLabel(view.id),
            icon: navViewIcons[view.id],
            active: activeView === view.id && activePane === "issues",
            onClick: () => onSelectView(view.id),
            // 手作業の件数は「いま実行できる数」（#1763）。前提待ちの件数は一覧のヘッダーで読む
            count: view.id === "check-user" ? checkUserCount : navCounts[view.id],
            // 確認待ちは残っている限り強調する（#742）。手作業はいま実行できるものがあるときだけ（#1613）
            emphasis:
              (view.id === "check-user" ? checkUserCount > 0 : manualStepAttention.actionable > 0)
                ? "attention"
                : "none",
          }),
        )}
      </ul>

      <div>
        <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">構想・相談</h2>
        <ul className="flex flex-col gap-0.5">
          {questionSignalRow("question")}
          {navRow({
            key: "remote-sessions",
            label: "リモートセッション",
            icon: TerminalSquare,
            active: activePane === "remote-sessions",
            onClick: onSelectRemoteSessions,
            count: remoteSessionCount,
            busy: remoteSessionStarting,
            title: "リポジトリを選んでClaude Codeのセッションを立ち上げる",
          })}
          {navRow({
            key: "ideas",
            label: "構想",
            icon: Lightbulb,
            active: activePane === "ideas",
            onClick: onSelectIdeas,
            count: ideasCount,
            title: "新規アプリの構想を確認・整理する",
          })}
          {navRow({
            key: "ios-extensions",
            label: "iOS拡張",
            icon: Smartphone,
            active: activePane === "ios-extensions",
            onClick: onSelectIosExtensions,
            title: "ウィジェット・ロック画面・ライブアクティビティ・コントロールを一覧する",
          })}
          {sidebarCodeReviewNavViews.map((view) => questionSignalRow(view.id))}
        </ul>
      </div>

      <div>
        <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">起案・準備</h2>
        <ul className="flex flex-col gap-0.5">
          {issueViewRow("not-started")}
          {navRow({
            key: "nightly",
            label: "予約実行",
            icon: CalendarClock,
            active: activePane === "nightly",
            onClick: onSelectNightlyRun,
            // 数えるのは積んである予定の件数（#2995）。確認待ちそのものは「確認待ち」が数える
            count: nightlyRunQueuedCount,
            title: "次の5時間枠の予定、直近の結果を見る",
          })}
        </ul>
      </div>

      <div>
        <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">実行・反映待ち</h2>
        <ul className="flex flex-col gap-0.5">
          {issueViewRow("in-progress")}
          {pullRequestRow("in-progress")}
          {pullRequestRow("completed")}
          {pullRequestRow("release")}
          {issueViewRow("release-pending")}
          {navRow({
            key: "flow",
            label: "ブランチ",
            icon: GitBranch,
            active: activePane === "flow",
            onClick: onSelectFlow,
            // 数えるのはリリース・デプロイが動いているリポジトリの数（#2167）。手作業は含めない
            count: releaseActivity?.total ?? null,
            emphasis: (releaseActivity?.actionRequired ?? 0) > 0 ? "attention" : "none",
            title: describeReleaseActivity(releaseActivity),
          })}
          {PREVIEW_NAV_VISIBLE &&
            navRow({
              key: "preview",
              label: "確認環境",
              icon: MonitorPlay,
              active: activePane === "preview",
              onClick: onSelectPreview,
              emphasis: previewRunning ? "attention" : "none",
              title: previewRunning
                ? "確認環境が動いています"
                : "developの最新をサブPCで動かして画面で確かめる",
            })}
        </ul>
      </div>

      <div>
        <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">反映済み</h2>
        <ul className="flex flex-col gap-0.5">
          {navRow({
            key: "releases",
            label: "リリース履歴",
            icon: History,
            active: activePane === "releases",
            onClick: onSelectReleaseHistory,
            // 未確認が無いあいだは0件のときも含めて出さない（#2951）
            count: releaseUncheckedCount && releaseUncheckedCount > 0 ? releaseUncheckedCount : null,
            emphasis: (releaseUncheckedCount ?? 0) > 0 ? "attention" : "none",
            title:
              releaseUncheckedCount && releaseUncheckedCount > 0
                ? `未確認のリリースが${releaseUncheckedCount}件あります`
                : "全リポジトリのGitHub Releaseを時系列で見る",
          })}
        </ul>
      </div>

      <Separator />

      {/* 補助メニュー。数字も丸も出さない（枠の逼迫は設定→「状態」のメーターが受け持つ） */}
      <ul className="flex flex-col gap-0.5">
        {navRow({
          key: "usage",
          label: "AI使用量",
          icon: Gauge,
          active: activePane === "usage",
          onClick: onSelectUsage,
          title: "サブPCのローカルセッションが使ったトークンを見る",
        })}
      </ul>
    </nav>
  );
}

