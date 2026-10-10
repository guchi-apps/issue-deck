"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  describeNativePushState,
  NATIVE_PUSH_REFRESH_EVENT,
  nativePushBridge,
  type NativePushActionResult,
  type NativePushStatus,
} from "@/lib/native-push";
import { pushEndpointKeyInBrowser } from "@/lib/push-client";
import { notifyPushSubscriptionChanged } from "@/lib/push-subscription-change";

/**
 * iOSアプリ内の「この端末」の通知状態と、オン・オフ操作（#4275）。
 * Web Pushの`usePushSubscription`の代わりに通知欄が使う。`enabled`がfalseなら何もしない。
 */
export function useNativePush(enabled: boolean) {
  const [status, setStatus] = useState<NativePushStatus | null>(null);
  const [serverEndpointKeys, setServerEndpointKeys] = useState<string[] | null>(null);
  const [tokenEndpointKey, setTokenEndpointKey] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 状態の取得に失敗したとき。操作の失敗（`error`）とは別に持ち、再取得の成功で消える */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await nativePushBridge.status();
      const key = next.token ? await pushEndpointKeyInBrowser(`apns:${next.token}`) : null;
      const res = await fetch("/api/notifications/subscribe");
      if (!res.ok) throw new Error(`登録状況を取得できませんでした (${res.status})`);
      const json = (await res.json()) as { subscriptions: { endpointKey: string }[] };
      setStatus(next);
      setTokenEndpointKey(key);
      setServerEndpointKeys(json.subscriptions.map((item) => item.endpointKey));
      setLoadError(null);
    } catch (err) {
      // 取得に失敗した状態をオンやオフと断定しない。直前の表示は「確認中」へ戻す
      setServerEndpointKeys(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const run = () => void refresh();
    run();
    // アプリが前面へ戻ったとき・設定アプリから戻ったとき（Swift側が合図を投げる）
    window.addEventListener(NATIVE_PUSH_REFRESH_EVENT, run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.removeEventListener(NATIVE_PUSH_REFRESH_EVENT, run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [enabled, refresh]);

  /** 連打で二重に走らせない。失敗時は理由を出し、実際の状態を引き直す */
  const run = useCallback(
    async (action: () => Promise<NativePushActionResult | void>, failure: string, success?: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);
      setError(null);
      setMessage(null);
      try {
        const result = await action();
        if (result && !result.serverOk) {
          setError(failure);
        } else if (success) {
          setMessage(success);
        }
        notifyPushSubscriptionChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
        await refresh();
      }
    },
    [refresh],
  );

  const turnOn = useCallback(
    () =>
      run(
        () => nativePushBridge.enable(),
        "登録できませんでした。通信状況を確かめて、もう一度お試しください",
      ),
    [run],
  );

  const turnOff = useCallback(
    () =>
      run(
        () => nativePushBridge.disable(),
        "サーバー側の解除に失敗しました。この端末は受け取らない設定にしましたが、もう一度オフにして解除を完了させてください",
      ),
    [run],
  );

  const openSettings = useCallback(() => void nativePushBridge.openSettings().catch(() => {}), []);

  const sendTest = useCallback(
    () =>
      run(async () => {
        // この端末だけに送る。他端末へ飛ぶと、画面の「この端末」の状態と食い違う
        const res = await fetch("/api/notifications/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpointKey: tokenEndpointKey }),
        });
        if (res.status === 400) throw new Error("この端末は登録されていません。先にオンにしてください");
        if (!res.ok) throw new Error(`テスト通知を送れませんでした (${res.status})`);
        const json = (await res.json()) as { sent: number; removed?: number; failed?: number };
        if (json.sent > 0) {
          setMessage("この端末へ送りました");
        } else if ((json.removed ?? 0) > 0) {
          throw new Error("この端末の登録は失効していました。「登録し直す」を押してください");
        } else {
          throw new Error("送信に失敗しました。時間をおいてもう一度お試しください");
        }
      }, "送信に失敗しました"),
    [run, tokenEndpointKey],
  );

  const state = describeNativePushState({ status, serverEndpointKeys, tokenEndpointKey });

  return { state, status, isSubmitting, error: error ?? loadError, message, turnOn, turnOff, openSettings, sendTest, refresh };
}
