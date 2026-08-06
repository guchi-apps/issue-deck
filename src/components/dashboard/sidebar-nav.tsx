"use client";

import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import {
  Archive,
  Eye,
  EyeOff,
  FolderGit2,
  Lock,
  Plus,
  Settings2,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";

import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { getLabelDotStyle } from "@/lib/label-color";
import { labelNavViews, navViewIcons, navViews } from "@/lib/nav-views";
import { getRepoColor } from "@/lib/repo-color";
import type { LabelSummary, NavViewId } from "@/types/issue";
import type { QuickFilter } from "@/types/quick-filter";
import type { ConnectedRepository } from "@/types/repository";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type SidebarNavProps = {
  activeView: NavViewId;
  onSelectView: (view: NavViewId) => void;
  navCounts: Record<NavViewId, number>;
  repositories: ConnectedRepository[];
  selectedRepoFullName?: string | null;
  onSelectRepository?: (repository: ConnectedRepository) => void;
  onClearRepository?: () => void;
  onHideRepository?: (repository: ConnectedRepository) => void;
  onShowRepository?: (repository: ConnectedRepository) => void;
  onSetRepositoryFavorite?: (repository: ConnectedRepository, favorite: boolean) => void;
  labelSummary: LabelSummary[];
  selectedLabels?: string[];
  onSelectLabel?: (label: LabelSummary) => void;
  onClearLabels?: () => void;
  quickFilters: QuickFilter[];
  onSelectQuickFilter: (quickFilter: QuickFilter) => void;
  onDeleteQuickFilter: (quickFilter: QuickFilter) => void;
  onSaveQuickFilter: () => void;
  className?: string;
  style?: CSSProperties;
};

export function SidebarNav({
  activeView,
  onSelectView,
  navCounts,
  repositories,
  selectedRepoFullName,
  onSelectRepository,
  onClearRepository,
  onHideRepository,
  onShowRepository,
  onSetRepositoryFavorite,
  labelSummary,
  selectedLabels = [],
  onSelectLabel,
  onClearLabels,
  quickFilters,
  onSelectQuickFilter,
  onDeleteQuickFilter,
  onSaveQuickFilter,
  className,
  style,
}: SidebarNavProps) {
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
  const [isEditingRepoVisibility, setIsEditingRepoVisibility] = useState(false);
  const sortedLabelSummary = [...labelSummary].sort((a, b) => a.name.localeCompare(b.name));
  const hiddenRepoCount = repositories.filter((repo) => repo.hidden).length;
  const visibleRepositories = showHiddenRepos
    ? repositories
    : repositories.filter((repo) => !repo.hidden);

  return (
    <nav className={cn("flex flex-col gap-6 overflow-y-auto p-4", className)} style={style}>
      <div>
        <h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">全体</h2>
        <ul className="flex flex-col gap-0.5">
          {navViews.map((view) => {
            const Icon = navViewIcons[view.id];
            return (
              <Fragment key={view.id}>
                {view.id === labelNavViews[0]?.id && (
                  <li aria-hidden="true">
                    <Separator className="my-1" />
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    onClick={() => onSelectView(view.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      activeView === view.id && "bg-accent font-medium",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      {view.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{navCounts[view.id]}</span>
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">リポジトリ</h2>
          <div className="flex items-center gap-1">
            {selectedRepoFullName && (
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
            <a href={getGithubAppInstallUrl()} className="ml-1 text-primary hover:underline">
              GitHub Appをインストール
            </a>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {visibleRepositories.map((repo) => {
                const color = getRepoColor(repo.fullName);
                return (
                  <li key={repo.id} className="group/repo flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelectRepository?.(repo)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                        selectedRepoFullName === repo.fullName && "bg-accent font-medium",
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
                      {(repo.archived || repo.private) && (
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
                );
              })}
            </ul>
            {hiddenRepoCount > 0 && (
              <button
                type="button"
                onClick={() => setShowHiddenRepos((prev) => !prev)}
                className="mt-1 px-2 text-xs text-primary hover:underline"
              >
                {showHiddenRepos ? "非表示のリポジトリを隠す" : `すべて表示する（${hiddenRepoCount}）`}
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

      <div className="mt-auto">
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">よく使うフィルター</h2>
          <button
            type="button"
            onClick={onSaveQuickFilter}
            className="text-muted-foreground hover:text-foreground"
            title="現在の検索条件を保存"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {quickFilters.length === 0 ? (
          <div className="rounded-lg border border-dashed p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <SlidersHorizontal className="size-3.5 text-muted-foreground" />
              クイックフィルターを作成
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              よく使う検索条件を保存できます
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {quickFilters.map((quickFilter) => (
              <li key={quickFilter.id} className="group/quick-filter flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelectQuickFilter(quickFilter)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{quickFilter.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteQuickFilter(quickFilter)}
                  title="削除"
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover/quick-filter:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
