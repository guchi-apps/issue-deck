"use client";

import { useEffect } from "react";

import { useNotificationState } from "@/components/dashboard/notification-state";
import { computeAppBadgeCount } from "@/lib/app-badge-count";

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * PWAのアプリアイコンのバッジへ確認待ち件数を出す（#3433）。描画はしない。
 * フッターの3タブの合計で、ホームとブランチに共通するPRは1件として数える。
 * 非対応のブラウザでは何もしない。
 */
export function AppBadgeSync({
  checkUserCount,
  checkUserPullRequestIds,
}: {
  checkUserCount: number;
  checkUserPullRequestIds: readonly string[];
}) {
  const { releaseMergePending, releaseUncheckedCount } = useNotificationState();
  const count = computeAppBadgeCount({
    checkUserCount,
    checkUserPullRequestIds,
    mergePending: releaseMergePending,
    releaseUncheckedCount,
  });

  useEffect(() => {
    const nav = navigator as BadgeNavigator;
    // 0件のときは消す。失敗（権限なし・非対応）は画面に関係しないので握りつぶす
    const update = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    update?.catch(() => {});
  }, [count]);

  return null;
}
