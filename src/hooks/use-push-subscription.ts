"use client";

import { useCallback, useEffect, useState } from "react";

import {
  describePushDeliveryState,
  detectPushAvailability,
  pushEndpointKeyInBrowser,
  SERVICE_WORKER_PATH,
  urlBase64ToArrayBuffer,
  type PushAvailability,
  type PushDeliveryState,
} from "@/lib/push-client";
import { notifyPushSubscriptionChanged } from "@/lib/push-subscription-change";

/**
 * Push通知（#838）の購読を、設定画面から登録・解除するためのフック。
 *
 * **Service Workerを登録するのはここだけ**で、しかも設定画面を開いたときにしか動かない。
 * アプリの起動時に必ず登録すると、通知を使わない人にも常駐するものが増える。
 */

export type PushSubscriptionView = {
  id: string;
  endpointKey: string;
  userAgent: string | null;
  createdAt: string;
};

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  // 登録直後は`pushManager`が使えるようになるまで少しかかる
  await navigator.serviceWorker.ready;
  return registration;
}

export function usePushSubscription(enabled: boolean) {
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionView[] | null>(null);
  /** この端末が持っている購読の一意キー（一覧で「この端末」を見分けるため） */
  const [currentEndpointKey, setCurrentEndpointKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // 設定画面を開いた時点・操作の後にだけ走る。ループにはならない
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    (async () => {
      const detected = detectPushAvailability();
      if (!cancelled) {
        setAvailability(detected);
        setPermission(typeof Notification === "undefined" ? null : Notification.permission);
      }

      try {
        const res = await fetch("/api/notifications/subscribe");
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const json = (await res.json()) as {
          publicKey: string | null;
          subscriptions: PushSubscriptionView[];
        };
        if (cancelled) return;
        setPublicKey(json.publicKey);
        setSubscriptions(json.subscriptions);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }

      // この端末が既に購読しているかは、サーバーではなくブラウザに聞く
      // （同じ端末でログインし直しても、購読そのものはブラウザ側に残っている）
      if (detected === "available") {
        try {
          const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
          // **登録済みでも更新を確かめる**（#2195）。`subscribe`のときしか`register`を
          // 呼んでおらず、ホーム画面から開きっぱなしのPWAは読み込み直す機会が無い。
          // 通知の出し方を直しても古いService Workerが動き続けると直らない。
          // 失敗しても購読の確認は続ける（オフラインでも画面は開ける）
          await registration?.update().catch(() => {});
          const existing = await registration?.pushManager.getSubscription();
          const key = existing ? await pushEndpointKeyInBrowser(existing.endpoint) : null;
          if (!cancelled) setCurrentEndpointKey(key);
        } catch {
          if (!cancelled) setCurrentEndpointKey(null);
        }
      }

      if (!cancelled) setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  /** この端末で通知を受け取り始める */
  const subscribe = useCallback(async () => {
    setError(null);
    setMessage(null);
    if (!publicKey) {
      setError("サーバーにPush通知用の鍵が設定されていません");
      return;
    }
    setIsSubmitting(true);
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        // 「許可しない」を選ぶと、次からは尋ねること自体ができない。何をすればよいかは
        // 画面側が`permission`を見て案内する
        return;
      }

      const registration = await registerServiceWorker();
      // 既に購読があればそれを使う。二重にsubscribeすると宛先が変わり、古い方が残る。
      // **ただしサーバー側に行が無い購読は捨ててから取り直す**（#2196）。失効（404/410）で
      // 消された宛先をそのまま登録し直すと、画面は「受け取り中」に戻るのに通知だけ届かない
      const existing = await registration.pushManager.getSubscription();
      const existingKey = existing ? await pushEndpointKeyInBrowser(existing.endpoint) : null;
      const isKnownToServer =
        existingKey !== null && (subscriptions ?? []).some((s) => s.endpointKey === existingKey);
      // 一覧を取れていないとき（subscriptionsがnull）は、判断材料が無いので捨てない
      const reusable = existing && (subscriptions === null || isKnownToServer) ? existing : null;
      if (existing && !reusable) await existing.unsubscribe();
      const subscription =
        reusable ??
        (await registration.pushManager.subscribe({
          // Web Push仕様上、画面に出さない通知（サイレントPush）は許されない
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(publicKey),
        }));

      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      if (!res.ok) throw new Error(`登録に失敗しました (${res.status})`);
      setCurrentEndpointKey(await pushEndpointKeyInBrowser(subscription.endpoint));
      // ダッシュボード側の出し分け（トーストを出すか）を切り替えさせる（#2196）
      notifyPushSubscriptionChanged();
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }, [publicKey, subscriptions, refetch]);

  /** この端末での受け取りをやめる */
  const unsubscribe = useCallback(async () => {
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        // **サーバー側を先に消す。** ブラウザ側だけ消えて行が残ると、届かない宛先へ
        // 送り続けることになる（失効として消えるのは実際に送ってからになる）
        await fetch("/api/notifications/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setCurrentEndpointKey(null);
      notifyPushSubscriptionChanged();
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }, [refetch]);

  /** 一覧から他の端末の購読を外す */
  const removeSubscription = useCallback(
    async (id: string) => {
      setError(null);
      setMessage(null);
      setIsSubmitting(true);
      try {
        const res = await fetch("/api/notifications/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) throw new Error(`解除に失敗しました (${res.status})`);
        // 外したのがこの端末のこともある。どちらでも引き直せば正しくなる
        notifyPushSubscriptionChanged();
        refetch();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSubmitting(false);
      }
    },
    [refetch],
  );

  /** テスト通知を送る。届くかどうかは確認待ちを待たずに確かめたい */
  const sendTest = useCallback(async () => {
    setError(null);
    setMessage(null);
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/notifications/test", { method: "POST" });
      if (!res.ok) throw new Error(`テスト通知を送れませんでした (${res.status})`);
      const json = (await res.json()) as { sent: number; removed?: number; failed?: number };
      // **「送れなかった」を「送り先が無い」と混ぜない**（#2195）。失効（404/410）で
      // 購読が消えたのか、一時的に送れなかったのかで、次にやることが違う
      if (json.sent > 0) {
        setMessage(`${json.sent}件の端末へ送りました`);
      } else if ((json.removed ?? 0) > 0) {
        setError(
          "この端末の購読は失効していました。「受け取りを止める」を押してから、もう一度「この端末で受け取る」で登録し直してください",
        );
        // サーバー側の行は消えている。一覧も合わせておかないと、登録済みに見えたまま残る
        refetch();
      } else if ((json.failed ?? 0) > 0) {
        setError("送信に失敗しました。時間をおいてもう一度お試しください");
      } else {
        setMessage("送り先がありませんでした。もう一度登録してください");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }, [refetch]);

  // **失効（ブラウザには購読があるのにサーバー側の行が無い）を「オフ」と混ぜない**（#2196）。
  // どちらも「受け取っていない」だが、ユーザーがやることが違う——失効は登録し直しが要る
  const deliveryState: PushDeliveryState = describePushDeliveryState({
    permission,
    browserEndpointKey: currentEndpointKey,
    serverEndpointKeys: subscriptions?.map((item) => item.endpointKey) ?? null,
  });

  return {
    availability,
    permission,
    publicKey,
    subscriptions,
    currentEndpointKey,
    deliveryState,
    isLoading,
    isSubmitting,
    error,
    message,
    subscribe,
    unsubscribe,
    removeSubscription,
    sendTest,
  };
}
