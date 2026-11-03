"use client";

import { useCallback, useEffect, useState } from "react";

import { NATIVE_PUSH_REFRESH_EVENT, nativePushBridge, type NativeBadgeStatus } from "@/lib/native-push";

/**
 * iOSアプリ内の「アプリアイコンのバッジ」の状態とオン・オフ操作（#5203）。
 * 状態が取れない間（古いビルド・通信失敗）はnullで、オンにもオフにも倒さない。
 */
export function useNativeBadge() {
  const [status, setStatus] = useState<NativeBadgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await nativePushBridge.badgeStatus());
      setError(null);
    } catch {
      setError("バッジの状態を取得できませんでした。アプリを更新してください");
    }
  }, []);

  useEffect(() => {
    const run = () => void refresh();
    run();
    // 設定アプリから戻ったときに許可の状態を取り直す
    window.addEventListener(NATIVE_PUSH_REFRESH_EVENT, run);
    return () => window.removeEventListener(NATIVE_PUSH_REFRESH_EVENT, run);
  }, [refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      setStatus(await nativePushBridge.setBadgeEnabled(enabled));
      setError(null);
    } catch {
      setError("バッジの設定を変更できませんでした");
    }
  }, []);

  return { status, error, setEnabled };
}
