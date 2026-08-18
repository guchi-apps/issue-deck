"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  ChevronRight,
  CircleSlash,
  FolderGit2,
  Lock,
  Search,
  Star,
  X,
} from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { NavCount } from "@/components/dashboard/nav-count";
import { Input } from "@/components/ui/input";
import { useRepositoryReleaseStatuses } from "@/hooks/use-repository-release-statuses";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import {
  describeReleaseStatusBadge,
  type ReleaseStatusBadge,
} from "@/lib/github/release-button-status";
import { navViewIcons } from "@/lib/nav-views";
import { getRepoColor } from "@/lib/repo-color";
import {
  isRepositoryAutomationUnsupported,
  REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE,
} from "@/lib/repository-automation";
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
  /**
   * 「すべてのリポジトリのIssue」の行に出す件数（#1951）。左メニュー・ホームと同じ
   * `navCounts`の「すべてのIssue」を渡す——ここで数え直すと、同じ名前の場所で違う数が出る。
   */
  allIssueCount: number;
  onSelectRepository: (repository: ConnectedRepository) => void;
  /** 全リポジトリ横断のIssue一覧を開く（#1951） */
  onSelectAllIssues: () => void;
  onSetRepositoryFavorite: (repository: ConnectedRepository, favorite: boolean) => void;
};

/** 「すべてのIssue」ビューのアイコン。遷移先の一覧で選ばれるビューと同じものを出す（#1951） */
const AllIssuesIcon = navViewIcons.all;

export function MobileReposScreen({
  repositories,
  allIssueCount,
  onSelectRepository,
  onSelectAllIssues,
  onSetRepositoryFavorite,
}: MobileReposScreenProps) {
  const [query, setQuery] = useState("");
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);

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
      <header className="flex shrink-0 items-center gap-1 border-b py-2 pr-2 pl-4">
        {/* フッターの「Issue」タブが開く画面なので、見出しもラベルに揃える（#1436）。
            中身はリポジトリ一覧のままで、リポジトリを選ぶとそのIssue一覧へ進む */}
        <h1 className="flex-1 text-base font-semibold">Issue</h1>
        {/* リポジトリの表示・非表示を切り替える口は設定画面に同じものがあるため、
            ここのアイコンは置かない（#1685） */}
        {/* 実行状況（#1638）。画面固有の操作の右隣＝ヘッダーの右端に固定する */}
        <MobileDispatchStatusButton />
        {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
        <MobileNotificationButton />
      </header>

      <div className="shrink-0 p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="リポジトリを検索..."
            className="pr-9 pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 入力を消す導線（#1788）。PCの検索欄と同じ位置・同じアイコンで揃える。
              指で押す場所なので、当たり判定はPCより少し大きめにとる */}
          {query !== "" && (
            <button
              type="button"
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-1.5 text-muted-foreground active:bg-accent"
              onClick={() => setQuery("")}
              aria-label="検索をクリア"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* 全リポジトリ横断のIssue一覧への入口（#1951）。この画面はリポジトリを1つ選ばないと
            Issueへ辿り着けず、横断の一覧を開くにはホームまで戻る必要があった。
            **検索窓の直下・一覧の外**に置く——リポジトリの行に混ぜると、検索やお気に入りの
            対象に見えるうえ、スクロールで流れて見つからなくなる */}
        <button
          type="button"
          onClick={onSelectAllIssues}
          className="mt-3 flex min-h-11 w-full items-center gap-2 rounded-md bg-accent/40 px-2 py-2 text-left text-sm hover:bg-accent"
        >
          <AllIssuesIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">すべてのリポジトリのIssue</span>
          <NavCount count={allIssueCount} />
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto border-t px-4 pt-3 pb-4">
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
                  repo.archived || repo.private || isRepositoryAutomationUnsupported(repo);
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
                              {isRepositoryAutomationUnsupported(repo) && (
                                <span title={REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE}>
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
