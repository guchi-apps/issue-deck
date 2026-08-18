"use client";

import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import {
  Archive,
  CircleSlash,
  Eye,
  EyeOff,
  FolderGit2,
  GitBranch,
  Lock,
  Plus,
  Settings2,
  Star,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { NavCount, type NavCountEmphasis } from "@/components/dashboard/nav-count";
import type { DashboardPane } from "@/hooks/use-issue-filters";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { getLabelDotStyle } from "@/lib/label-color";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import {
  navViewIcons,
  sidebarAttentionNavViews,
  sidebarIssueNavViews,
  sidebarQuestionNavViews,
} from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { pullRequestViewIcons, sidebarPullRequestViews } from "@/lib/pull-request-views";
import { getRepoColor } from "@/lib/repo-color";
import {
  isRepositoryAutomationUnsupported,
  REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE,
} from "@/lib/repository-automation";
import type { LabelSummary, NavViewId } from "@/types/issue";
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
  navCounts: Record<NavViewId, number>;
  /**
   * 「ユーザーの確認待ち」へ一緒に出す、ユーザーのマージ待ちPRの件数（#1613）。
   * 対応Issueが同じ一覧に並ぶPRは含まない（`pullRequestsAwaitingUserMerge`）。
   */
  checkUserPullRequestCount: number;
  /** 「ユーザーの作業待ち」の内訳（#1613）。いま実行できるものがあるときだけ強調する */
  manualStepAttention: ManualStepAttention;
  /**
   * 未確認（回答が届いていて未読）の質問Issueの件数（#1796）。
   * 「質問」の件数として出し、1件以上のときはオレンジの丸で強調する（#1910）。
   */
  unconfirmedQuestionCount: number;
  /** PRビューごとの件数（#1389）。nullのビューは件数を出さない */
  pullRequestNavCounts: PullRequestNavCounts;
  repositories: ConnectedRepository[];
  selectedRepoFullNames?: string[];
  onSelectRepository?: (repository: ConnectedRepository) => void;
  onClearRepository?: () => void;
  onHideRepository?: (repository: ConnectedRepository) => void;
  onShowRepository?: (repository: ConnectedRepository) => void;
  onSetRepositoryFavorite?: (repository: ConnectedRepository, favorite: boolean) => void;
  labelSummary: LabelSummary[];
  selectedLabels?: string[];
  onSelectLabel?: (label: LabelSummary) => void;
  onClearLabels?: () => void;
  className?: string;
  style?: CSSProperties;
};

export function SidebarNav({
  activeView,
  onSelectView,
  activePane,
  activePullRequestView,
  onSelectPullRequestView,
  onSelectFlow,
  navCounts,
  checkUserPullRequestCount,
  manualStepAttention,
  unconfirmedQuestionCount,
  pullRequestNavCounts,
  repositories,
  selectedRepoFullNames = [],
  onSelectRepository,
  onClearRepository,
  onHideRepository,
  onShowRepository,
  onSetRepositoryFavorite,
  labelSummary,
  selectedLabels = [],
  onSelectLabel,
  onClearLabels,
  className,
  style,
}: SidebarNavProps) {
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
  const [isEditingRepoVisibility, setIsEditingRepoVisibility] = useState(false);
  const sortedLabelSummary = [...labelSummary].sort((a, b) => a.name.localeCompare(b.name));
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
          </span>
          {/* 強調の使い分けと見た目は`NavCount`（スマホのホームと共通） */}
          <NavCount count={count} emphasis={emphasis} />
        </button>
      </li>
    );
  }

  return (
    <nav className={cn("flex flex-col gap-6 overflow-y-auto p-4", className)} style={style}>
      {/* 人が動くまで進まないもの（#1613）。見出しを付けず最上段に固定し、上から順に
          手を動かせば盤面が進む並びにする */}
      <div className="flex flex-col gap-1">
        <ul className="flex flex-col gap-0.5">
          {sidebarAttentionNavViews.map((view) =>
            navRow({
              key: view.id,
              label: view.label,
              icon: navViewIcons[view.id],
              active: activeView === view.id && activePane === "issues",
              onClick: () => onSelectView(view.id),
              // 手作業の件数は「いま実行できる数」（#1763。`computeNavCounts`で数え済み）。
              // 内訳の吹き出しは付けない——数字がそのまま実行できる件数を指すため、
              // 同じことを言い直すだけになる。前提待ちの件数は一覧のヘッダーで読む
              count: view.id === "check-user" ? checkUserCount : navCounts[view.id],
              // 確認待ちは残っている限り強調する（#742）。手作業はいま実行できるものが
              // あるときだけで、前提待ちしか無い間は強調しない（#1613）。
              emphasis:
                (view.id === "check-user" ? checkUserCount > 0 : manualStepAttention.actionable > 0)
                  ? "attention"
                  : "none",
            }),
          )}
        </ul>

        <Separator className="my-1" />

        <ul className="flex flex-col gap-0.5">
          {sidebarQuestionNavViews.map((view) =>
            navRow({
              key: view.id,
              label: view.label,
              icon: navViewIcons[view.id],
              active: activeView === view.id && activePane === "issues",
              onClick: () => onSelectView(view.id),
              // 件数は未確認（回答が届いていて未読）の数で、確認待ち・作業待ちと同じく
              // 「いま手を動かせる数」を出す（#1910）。総数との差は一覧のヘッダーの
              // 内訳（`3件・未確認1件`）で読む
              count: unconfirmedQuestionCount,
              emphasis: unconfirmedQuestionCount > 0 ? "attention" : "none",
              title:
                unconfirmedQuestionCount > 0
                  ? `回答が届いていてまだ開いていない質問が${unconfirmedQuestionCount}件あります`
                  : undefined,
            }),
          )}
          {navRow({
            key: "flow",
            label: "ブランチ",
            icon: GitBranch,
            active: activePane === "flow",
            onClick: onSelectFlow,
            title: "Issue・ブランチ・Pull Requestの関係とマージ先までの流れ",
          })}
        </ul>
      </div>

      <div>
        <h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">Issue</h2>
        <ul className="flex flex-col gap-0.5">
          {sidebarIssueNavViews.map((view) =>
            navRow({
              key: view.id,
              label: view.label,
              icon: navViewIcons[view.id],
              active: activeView === view.id && activePane === "issues",
              onClick: () => onSelectView(view.id),
              count: navCounts[view.id],
            }),
          )}
        </ul>
      </div>

      <div>
        <h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">Pull Request</h2>
        <ul className="flex flex-col gap-0.5">
          {sidebarPullRequestViews.map((view) =>
            navRow({
              key: view.id,
              label: view.label,
              icon: pullRequestViewIcons[view.id],
              active: activePane === "pull-requests" && activePullRequestView === view.id,
              onClick: () => onSelectPullRequestView(view.id),
              count: pullRequestNavCounts[view.id],
              title: view.description,
            }),
          )}
        </ul>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">リポジトリ</h2>
          <div className="flex items-center gap-1">
            {selectedRepoFullNames.length > 0 && (
              <button
                type="button"
                onClick={() => onClearRepository?.()}
                className="text-muted-foreground hover:text-foreground"
                title="リポジトリの選択を解除"
              >
                <X className="size-3.5" />
              </button>
            )}
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
              className="text-muted-foreground hover:text-foreground"
              title="GitHub Appをインストールしてリポジトリを追加"
            >
              <Plus className="size-3.5" />
            </a>
          </div>
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

      <div>
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">ラベル</h2>
          {selectedLabels.length > 0 && (
            <button
              type="button"
              onClick={() => onClearLabels?.()}
              className="text-muted-foreground hover:text-foreground"
              title="ラベルの選択を解除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-0.5">
          {sortedLabelSummary.map((label) => (
            <li key={label.name}>
              <button
                type="button"
                onClick={() => onSelectLabel?.(label)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  selectedLabels.includes(label.name) && "bg-accent font-medium",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="size-2 rounded-full ring-1 ring-inset ring-border"
                    style={getLabelDotStyle(label.color)}
                  />
                  {label.name}
                </span>
                <span className="text-xs text-muted-foreground">{label.count}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-1 px-2 text-xs text-primary hover:underline">
          すべてのラベルを見る
        </button>
      </div>
    </nav>
  );
}
