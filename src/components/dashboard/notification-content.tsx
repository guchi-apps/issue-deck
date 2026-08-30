"use client";

import {
  Bell,
  GitMerge,
  GitPullRequest,
  MessageCircleQuestion,
  TriangleAlert,
  UserCheck,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  NOTIFICATION_GROUP_LABEL,
  type NotificationGroup,
  type NotificationItem,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

const GROUP_ICON: Record<NotificationGroup, LucideIcon> = {
  release: GitMerge,
  "check-user": UserCheck,
  session: MessageCircleQuestion,
  "pull-request": GitPullRequest,
  "manual-step": Wrench,
};

/**
 * 通知ベルの中身（#1614・#1772）。
 *
 * **PCのポップオーバー（`notification-button.tsx`）とスマホのボトムシート
 * （`mobile/mobile-notification-button.tsx`）が同じものを出す。** 出し方（ポップオーバーか
 * シートか）と置き場所だけが違い、中身が食い違う理由が無いため共通化してある
 * （実行キューの`dispatch-queue-content.tsx`と同じ形）。
 *
 * **何を通知にするかの判定はここには無い。** 組み立ては`lib/notifications.ts`（純粋関数）で、
 * ここは受け取った`items`を描くだけ。
 *
 * **押されたことを伝えるだけで、閉じる操作はしない**（`DispatchQueueContent`と同じ）。
 * ポップオーバーを閉じてから遷移するのかシートを閉じてから遷移するのかは、置いた側が決める。
 */
export function NotificationContent({
  items,
  groups,
  onSelect,
  onOpenCheckUserView,
  onOpenFlow,
  /** 一覧の高さの上限。PCはポップオーバーの中で、スマホはシートの中で別々に決める */
  listClassName = "max-h-96 overflow-y-auto",
}: {
  items: NotificationItem[];
  groups: { group: NotificationGroup; items: NotificationItem[] }[];
  onSelect: (item: NotificationItem) => void;
  /** 「確認待ちを一覧で見る」。左メニュー（スマホはIssue一覧）の同名ビューへ移る */
  onOpenCheckUserView: () => void;
  /** 「ブランチ画面を開く」。リリースの起動・マージはこちらに寄せた（#1614） */
  onOpenFlow: () => void;
  listClassName?: string;
}) {
  return (
    <>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-xs text-muted-foreground">
          <Bell className="size-6" />
          いま対応が必要なものはありません
        </div>
      ) : (
        <div className={listClassName}>
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
                        onClick={() => onSelect(item)}
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
        <Button variant="outline" size="xs" onClick={onOpenCheckUserView}>
          確認待ちを一覧で見る
        </Button>
        <Button variant="outline" size="xs" onClick={onOpenFlow}>
          ブランチ画面を開く
        </Button>
      </div>
    </>
  );
}

/**
 * ベルに重ねる件数バッジ（#1614・#1772）。PCのトップバーとスマホのヘッダーで同じ規則にする。
 *
 * **1件でも失敗（CIの失敗など）が混ざれば赤、それ以外は橙。** 開かずに「直す必要がある」と
 * 気づけるのはここだけのため（判定は`hasErrorNotification`）。0件のときは何も出さない。
 *
 * **渡す`count`は一覧の行数ではなく`countBadgeNotifications`の結果**（#1936）。手作業待ちは
 * 一覧には並ぶがここには数えない（理由は`lib/notifications.ts`の`BADGE_EXCLUDED_GROUPS`）。
 *
 * 重ねる位置だけはボタンの大きさで変える。PCは`size-8`、スマホは指で押せる`size-11`で、
 * 同じオフセットにするとスマホではアイコンから離れて宙に浮く。
 */
export function NotificationBadge({
  count,
  hasError,
  className = "-top-1 -right-1",
}: {
  count: number;
  hasError: boolean;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <span
      className={cn(
        "absolute flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white",
        hasError ? "bg-destructive" : "bg-amber-500",
        className,
      )}
    >
      {count}
    </span>
  );
}

/**
 * ボタンのtitle・シートの見出しに添える件数の文言。0件でも押せることが分かる文言にする。
 * **渡すのはバッジと同じ件数**（手作業待ちを除く。#1936）——バッジに出ている数字とツールチップが
 * 食い違うと、どちらが本当なのか分からなくなる。
 */
export function describeNotificationTitle(count: number): string {
  return count > 0 ? `対応が必要なもの（${count}件）` : "対応が必要なもの";
}
