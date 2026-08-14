"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  CircleSlash,
  Eye,
  EyeOff,
  FolderGit2,
  Lock,
  Search,
  Settings2,
  Star,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { useRepositoryReleaseStatuses } from "@/hooks/use-repository-release-statuses";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import {
  describeReleaseStatusBadge,
  type ReleaseStatusBadge,
} from "@/lib/github/release-button-status";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { ConnectedRepository } from "@/types/repository";

/**
 * この画面を開いている間、動いているリポジトリがある場合の再取得間隔（#1117）。
 * スマホからリリースの進み具合を見に来ている状況なので、既定の5分より短くする。
 * 動きが無い間は既定の間隔に戻るため、リリース中でなければAPI消費は増えない。
 */
const ACTIVE_POLL_INTERVAL_MS = 60_000;

const BADGE_TONE_CLASS: Record<ReleaseStatusBadge["tone"], string> = {
  progressing: "bg-sky-500/15 text-sky-700 ring-sky-500/40 dark:text-sky-400",
  action: "bg-amber-500/15 text-amber-700 ring-amber-500/40 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive ring-destructive/40",
};

type MobileReposScreenProps = {
  repositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
  onHideRepository: (repository: ConnectedRepository) => void;
  onShowRepository: (repository: ConnectedRepository) => void;
  onSetRepositoryFavorite: (repository: ConnectedRepository, favorite: boolean) => void;
};

export function MobileReposScreen({
  repositories,
  onSelectRepository,
  onHideRepository,
  onShowRepository,
  onSetRepositoryFavorite,
}: MobileReposScreenProps) {
  const [query, setQuery] = useState("");
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
  const [isEditingRepoVisibility, setIsEditingRepoVisibility] = useState(false);

  // 本番ワークフローの進捗を一覧で把握できるようにする（#1117）。取得はこの画面を
  // 開いている間だけで、`idle`のリポジトリはAPIが返さないためバッジも出ない。
  const { data: releaseStatuses } = useRepositoryReleaseStatuses(repositories.length > 0, {
    activeIntervalMs: ACTIVE_POLL_INTERVAL_MS,
  });
  const releaseBadgeByRepo = useMemo(() => {
    const map = new Map<string, ReleaseStatusBadge>();
    (releaseStatuses ?? []).forEach((releaseStatus) => {
      const badge = describeReleaseStatusBadge({
        status: releaseStatus.status,
        failedWorkflow: releaseStatus.failedWorkflow,
        mergeTarget: releaseStatus.pendingMerge?.mergeTarget ?? null,
        ciState: releaseStatus.pendingMerge?.ciState ?? null,
      });
      if (badge) map.set(releaseStatus.repoFullName, badge);
    });
    return map;
  }, [releaseStatuses]);

  const trimmedQuery = query.trim().toLowerCase();
  const hiddenRepoCount = repositories.filter((repo) => repo.hidden).length;
  const visibleRepositories = showHiddenRepos
    ? repositories
    : repositories.filter((repo) => !repo.hidden);
  const filtered = trimmedQuery
    ? visibleRepositories.filter((repo) => repo.name.toLowerCase().includes(trimmedQuery))
    : visibleRepositories;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b p-4">
        <h1 className="text-base font-semibold">リポジトリ</h1>
        <button
          type="button"
          onClick={() => setIsEditingRepoVisibility((prev) => !prev)}
          title={
            isEditingRepoVisibility
              ? "表示・非表示の切り替えを終了"
              : "表示・非表示を切り替える"
          }
          aria-label={
            isEditingRepoVisibility
              ? "表示・非表示の切り替えを終了"
              : "表示・非表示を切り替える"
          }
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
            isEditingRepoVisibility && "bg-accent text-foreground",
          )}
        >
          <Settings2 className="size-4" />
        </button>
      </header>

      <div className="shrink-0 p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="リポジトリを検索..."
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {repositories.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
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
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            該当するリポジトリがありません
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {filtered.map((repo) => {
                const color = getRepoColor(repo.fullName);
                const releaseBadge = releaseBadgeByRepo.get(repo.fullName);
                const hasStateIcons =
                  repo.archived || repo.private || !repo.hasClaudeWorkflow;
                return (
                  <li key={repo.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelectRepository(repo)}
                      className={cn(
                        "flex min-h-11 min-w-0 flex-1 items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                        repo.hidden && "text-muted-foreground",
                      )}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span
                          className="flex size-6 shrink-0 items-center justify-center rounded"
                          style={{ backgroundColor: `${color}20`, color }}
                        >
                          <FolderGit2 className="size-3.5" />
                        </span>
                        <span className="truncate">{repo.name}</span>
                      </span>
                      {(releaseBadge || hasStateIcons) && (
                        <span className="flex shrink-0 items-center gap-1.5 pl-2">
                          {releaseBadge && (
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                                BADGE_TONE_CLASS[releaseBadge.tone],
                              )}
                            >
                              {releaseBadge.label}
                            </span>
                          )}
                          {hasStateIcons && (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              {repo.archived && (
                                <span title="アーカイブ済み">
                                  <Archive className="size-3.5" />
                                </span>
                              )}
                              {repo.private && (
                                <span title="プライベートリポジトリ">
                                  <Lock className="size-3.5" />
                                </span>
                              )}
                              {!repo.hasClaudeWorkflow && (
                                <span title="issue-deckの自動化workflow（claude-issue-dispatch.yml）が見つかりません（対応可否の近似判定です）">
                                  <CircleSlash className="size-3.5" />
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSetRepositoryFavorite(repo, !repo.favorite)}
                      title={repo.favorite ? "お気に入りから外す" : "お気に入りに追加"}
                      aria-label={repo.favorite ? "お気に入りから外す" : "お気に入りに追加"}
                      className={cn(
                        "flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
                        repo.favorite ? "text-yellow-500" : "text-muted-foreground",
                      )}
                    >
                      <Star className={cn("size-4", repo.favorite && "fill-yellow-400")} />
                    </button>
                    {isEditingRepoVisibility && (
                      <button
                        type="button"
                        onClick={() =>
                          repo.hidden ? onShowRepository(repo) : onHideRepository(repo)
                        }
                        title={repo.hidden ? "表示する" : "非表示にする"}
                        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {repo.hidden ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
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
                className="mt-2 flex min-h-11 items-center px-2 text-sm text-primary hover:underline"
              >
                {showHiddenRepos ? "非表示のリポジトリを隠す" : `すべて表示する（${hiddenRepoCount}）`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
