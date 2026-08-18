"use client";

import { useEffect, useRef } from "react";

import { useNotificationState } from "@/components/dashboard/notification-state";
import { RefreshIndicatorButton } from "@/components/dashboard/refresh-indicator-button";
import { useAutoRefresh } from "@/hooks/use-auto-refresh";

/**
 * 通知ベル「対応が必要なもの」の右上に置く更新ボタン（#1909）。
 *
 * **開いている間の自動更新をこのコンポーネントが持つ。** ポップオーバー（PC）もシート
 * （スマホ）も閉じている間は中身を描かないので、ここを開いた側のヘッダーへ置くだけで
 * 「開いている間だけ30秒ごとに取り直す」になる。Provider側に持たせると、開いているかどうかを
 * 2つのベルから伝える仕組みが要る。
 *
 * **開いた直後にも1回取りに行く**（`useAutoRefresh`が有効になった時点で1回呼ぶ）。以前は
 * ベルを開く操作の側で取り直していたが、ここが同じことをするため置き換えた。
 *
 * 見た目と文言は実行キューの更新ボタン（#1773）と共通（`refresh-indicator-button.tsx`）。
 */
export function NotificationRefreshButton({ className }: { className?: string }) {
  const { refresh, isFetching, fetchedAt, pollIntervalMs } = useNotificationState();

  // 取得関数そのものではなくrefを渡す（`useAutoRefresh`の作法）。取り直しのたびに
  // ポーリングのeffectが張り直されないようにするため。
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useAutoRefresh(pollIntervalMs, refreshRef);

  return (
    <RefreshIndicatorButton
      fetchedAt={fetchedAt}
      isFetching={isFetching}
      pollIntervalMs={pollIntervalMs}
      onRefresh={refresh}
      label="対応が必要なものを今すぐ更新"
      className={className}
    />
  );
}
