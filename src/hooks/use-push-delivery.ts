"use client";

import { useEffect, useState } from "react";

import {
  describePushDeliveryState,
  detectPushAvailability,
  pushEndpointKeyInBrowser,
  SERVICE_WORKER_PATH,
  type PushDeliveryState,
} from "@/lib/push-client";
import { onPushSubscriptionChanged } from "@/lib/push-subscription-change";

/**
 * この端末に確認待ちの通知が「OSの通知として」届いているか（#2196）。
 *
 * 使うのはダッシュボード（`issue-deck-shell.tsx`）で、**届いているあいだは画面内の
 * トーストを出さない**。Service Workerは表示中でも必ず通知を出すようになったため
 * （`public/sw.js`）、両方出すと同じ知らせを2か所で受けることになる。
 *
 * **判定は「届いている」と言い切れるときだけ`delivering`にする。** 判断できないものを
 * `delivering`へ倒すと、通知もトーストも出ない状態になりうる。購読を持っていない端末では
 * サーバーへ問い合わせずに終える（大半の端末はここで終わり、通信は増えない）。
 */

/**
 * 判定を取り直す間隔。
 *
 * **開いたまま失効することがある**（計画レビューの指摘）。送信時に404/410が返ると
 * `sendPushNotification`がその場で購読行を消すので、開いた瞬間の1回だけで固定すると
 * そのセッションのあいだトーストが止まったままになる。取り直すのは`GET`1本なので、
 * 10秒ごとに回っているIssue一覧のポーリングに比べれば誤差。
 */
export const PUSH_DELIVERY_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** いまの受け取り状況を1回だけ調べる */
async function readPushDeliveryState(): Promise<PushDeliveryState> {
  if (detectPushAvailability() !== "available") return "off";
  const permission = typeof Notification === "undefined" ? null : Notification.permission;

  // **`register`はしない。** Service Workerを登録するのは設定画面だけで、
  // 通知を使わない人にも常駐するものを増やさない（`use-push-subscription.ts`）
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  const subscription = await registration?.pushManager.getSubscription();
  const browserEndpointKey = subscription
    ? await pushEndpointKeyInBrowser(subscription.endpoint)
    : null;
  if (browserEndpointKey === null || permission !== "granted") {
    return describePushDeliveryState({ permission, browserEndpointKey, serverEndpointKeys: null });
  }

  // **サーバー側にも行が残っているかまで見る**。失効（404/410）で消された購読は
  // ブラウザ側にだけ残ることがあり、それを「届いている」と数えると通知もトーストも消える
  const res = await fetch("/api/notifications/subscribe");
  if (!res.ok) return "unknown";
  const json = (await res.json()) as { subscriptions?: { endpointKey: string }[] };
  return describePushDeliveryState({
    permission,
    browserEndpointKey,
    serverEndpointKeys: (json.subscriptions ?? []).map((item) => item.endpointKey),
  });
}

export function usePushDeliveryState(): PushDeliveryState {
  const [state, setState] = useState<PushDeliveryState>("unknown");

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      readPushDeliveryState()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        // 判断できないままにしておく（トーストは出る側）
        .catch(() => {
          if (!cancelled) setState("unknown");
        });
    };

    check();
    // 設定画面での登録・解除は同じページの中で起きるので、イベントで受けて引き直す。
    // 端末の通知設定は画面の外で変えられるため、戻ってきたときにも確かめる
    const stopListening = onPushSubscriptionChanged(check);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // 開いたままでも失効する（送信時の404/410で消える）ので、定期的に取り直す
    const timer = setInterval(check, PUSH_DELIVERY_RECHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopListening();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(timer);
    };
  }, []);

  return state;
}
