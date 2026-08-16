"use client";

import { useMemo, useState } from "react";
import {
  Bell,
  GitMerge,
  GitPullRequest,
  TriangleAlert,
  UserCheck,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRepositoryReleaseStatuses } from "@/hooks/use-repository-release-statuses";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  buildNotifications,
  groupNotifications,
  hasErrorNotification,
  NOTIFICATION_GROUP_LABEL,
  type NotificationGroup,
  type NotificationItem,
  type NotificationTarget,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

type NotificationButtonProps = {
  repositories: ConnectedRepository[];
  issues: Issue[];
  pullRequests: PullRequestSummary[];
  onOpenTarget: (target: NotificationTarget) => void;
  /** 「確認待ちを一覧で見る」。左メニューの同名ビューへ移る */
  onOpenCheckUserView: () => void;
  /** 「ブランチ画面を開く」。リリースの起動・マージはこちらに寄せた（#1614） */
  onOpenFlow: () => void;
};

const GROUP_ICON: Record<NotificationGroup, LucideIcon> = {
  release: GitMerge,
  "check-user": UserCheck,
  "pull-request": GitPullRequest,
  "manual-step": Wrench,
};

/**
 * PC画面のヘッダー常時表示（#1614）。リリース専用だったロケットボタン
 * （`release-status-button.tsx`）を置き換え、**ユーザーの操作が必要なものをリポジトリ横断で
 * 1か所に集める**。
 *
 * ロケットが持っていたリリースの起動・マージ・バージョン確認は「ブランチ」画面
 * （`branch-flow-view.tsx`）が同じものを持っているためそちらへ寄せ、ここには
 * 「どのリポジトリで人の操作が要るか」だけを残した。リリース以外（確認待ち・手作業待ち・
 * マージ待ちPR）も同じ基準で並ぶ。
 *
 * **追加のGitHub API消費はゼロ。** Issue・PRは`IssueDeckShell`が既に取得済みのものを受け取り、
 * リリース状況はロケットが使っていた`useRepositoryReleaseStatuses`をそのまま引き継ぐ。
 * 何を通知にするかの判定は`lib/notifications.ts`（純粋関数）にある。
 */
export function NotificationButton({
  repositories,
  issues,
  pullRequests,
  onOpenTarget,
  onOpenCheckUserView,
  onOpenFlow,
}: NotificationButtonProps) {
  const [open, setOpen] = useState(false);

  // 連携しているリポジトリが1件でもあれば取りに行く（スマホのリポジトリ一覧と同じ条件）。
  // **`hasClaudeWorkflow`では絞らない**（#1727）。あれは`claude-issue-dispatch.yml`の有無で
  // 「リリースworkflow導入済み」を代用していたもので、無人実行を入れずにリリースフローだけを
  // 載せたリポジトリ（`subpc`・`vps`）が通知から丸ごと抜け落ちる。実際にどのリポジトリを
  // 対象にするかはAPI側が`release-develop-to-main.yml`の実在で決める。
  const hasConnectedRepository = repositories.length > 0;
  const { data: releaseStatuses, refetch: refetchReleaseStatuses } =
    useRepositoryReleaseStatuses(hasConnectedRepository);

  const items = useMemo(
    () => buildNotifications({ issues, pullRequests, releaseStatuses }),
    [issues, pullRequests, releaseStatuses],
  );
  const groups = useMemo(() => groupNotifications(items), [items]);
  const hasError = hasErrorNotification(items);

  function handleSelect(item: NotificationItem) {
    setOpen(false);
    onOpenTarget(item.target);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // 開いた時点の状態で判断できるよう取り直す（バックグラウンドの再取得は5分間隔のため）
        if (nextOpen) void refetchReleaseStatuses();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent"
          title={items.length > 0 ? `対応が必要なもの（${items.length}件）` : "対応が必要なもの"}
          aria-label="対応が必要なもの"
        >
          <Bell className="size-4" />
          {items.length > 0 && (
            <span
              className={cn(
                "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white",
                hasError ? "bg-destructive" : "bg-amber-500",
              )}
            >
              {items.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-2">
          <h3 className="text-xs font-semibold">対応が必要なもの</h3>
          <span className="text-xs text-muted-foreground">{items.length}件</span>
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-xs text-muted-foreground">
            <Bell className="size-6" />
            いま対応が必要なものはありません
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {groups.map(({ group, items: groupItems }) => {
              const Icon = GROUP_ICON[group];
              return (
                <section key={group}>
                  <h4 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {NOTIFICATION_GROUP_LABEL[group]}
                  </h4>
                  <ul>
                    {groupItems.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => handleSelect(item)}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent"
                        >
                          <span
                            className={cn(
                              "mt-0.5 shrink-0",
                              item.tone === "error"
                                ? "text-destructive"
                                : item.tone === "action"
                                  ? "text-amber-700 dark:text-amber-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {item.tone === "error" ? (
                              <TriangleAlert className="size-3.5" />
                            ) : (
                              <Icon className="size-3.5" />
                            )}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="line-clamp-2 text-xs">{item.title}</span>
                            <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span
                                className={cn(
                                  "rounded-full px-1.5 font-medium",
                                  item.tone === "error"
                                    ? "bg-destructive/15 text-destructive"
                                    : item.tone === "action"
                                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                      : "bg-muted",
                                )}
                              >
                                {item.badgeLabel}
                              </span>
                              <span className="truncate">{item.repositoryFullName}</span>
                              {item.since && <span>・{formatRelativeDate(item.since)}</span>}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 border-t p-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setOpen(false);
              onOpenCheckUserView();
            }}
          >
            確認待ちを一覧で見る
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setOpen(false);
              onOpenFlow();
            }}
          >
            ブランチ画面を開く
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
