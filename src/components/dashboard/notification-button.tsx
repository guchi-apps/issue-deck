"use client";

import { useState } from "react";
import { Bell } from "lucide-react";

import {
  describeNotificationTitle,
  NotificationBadge,
  NotificationContent,
} from "@/components/dashboard/notification-content";
import { NotificationRefreshButton } from "@/components/dashboard/notification-refresh-button";
import { useNotificationState } from "@/components/dashboard/notification-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NotificationItem, NotificationTarget } from "@/lib/notifications";

type NotificationButtonProps = {
  onOpenTarget: (target: NotificationTarget) => void;
  /** 「確認待ちを一覧で見る」。左メニューの同名ビューへ移る */
  onOpenCheckUserView: () => void;
  /** 「ブランチ画面を開く」。リリースの起動・マージはこちらに寄せた（#1614） */
  onOpenFlow: () => void;
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
 * **中身とバッジはスマホのベル（`mobile/mobile-notification-button.tsx`）と共通**
 * （`notification-content.tsx`。#1772）。ここが持つのはポップオーバーで出すことと、
 * 押されたときに閉じてから遷移することだけ。
 *
 * **材料は`NotificationProvider`（`notification-state.tsx`）が1か所で用意したものを読む。**
 * 開いている間だけ30秒ごとに取り直し、いつ時点の内容かを右上に出す（#1909。
 * `notification-refresh-button.tsx`）。閉じている間に増える取得は無い。
 */
export function NotificationButton({
  onOpenTarget,
  onOpenCheckUserView,
  onOpenFlow,
}: NotificationButtonProps) {
  const [open, setOpen] = useState(false);
  const { items, groups, badgeCount, countLabel, hasError } = useNotificationState();

  function handleSelect(item: NotificationItem) {
    setOpen(false);
    onOpenTarget(item.target);
  }

  return (
    // 開いた時点の取り直しと、開いている間の自動更新は中身の側が持つ
    // （`notification-refresh-button.tsx`。#1909）
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent"
          title={describeNotificationTitle(badgeCount)}
          aria-label="対応が必要なもの"
        >
          <Bell className="size-4" />
          {/* 数えるのは手作業待ちを除いたぶん（#1936）。中身の一覧には手作業待ちも並ぶ */}
          <NotificationBadge count={badgeCount} hasError={hasError} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        {/* 件数の右に更新ボタンを並べる（#1909）。いつ時点の内容かは、開いたまま見ている
            人にとって件数と同じくらい判断の材料になる */}
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
          <h3 className="text-xs font-semibold">対応が必要なもの</h3>
          <div className="flex items-center gap-1.5">
            {/* バッジに数えていない手作業待ちがあれば内訳が付く（#1936） */}
            <span className="text-xs text-muted-foreground">{countLabel}</span>
            <NotificationRefreshButton />
          </div>
        </div>

        <NotificationContent
          items={items}
          groups={groups}
          onSelect={handleSelect}
          onOpenCheckUserView={() => {
            setOpen(false);
            onOpenCheckUserView();
          }}
          onOpenFlow={() => {
            setOpen(false);
            onOpenFlow();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
