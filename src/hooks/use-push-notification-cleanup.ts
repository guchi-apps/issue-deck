"use client";

import { useEffect } from "react";

import { isNativeApp, NATIVE_PUSH_REFRESH_EVENT, nativePushBridge } from "@/lib/native-push";
import { selectStalePushTags } from "@/lib/notifications/stale-push";
import { SERVICE_WORKER_PATH } from "@/lib/push-client";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 用の済んだPush通知を、OSの通知センターから閉じる（#2407）。
 *
 * **通知はタップするまで端末に残る。** `public/sw.js`が`close()`を呼ぶのは
 * `notificationclick`のときだけなので、確認待ちのラベルが外れても、リリースPRを
 * マージしても、ロック画面には知らせが並んだままになる。閉じられるのは通知を出した
 * Service Workerだけなので、画面がその窓口になる。
 *
 * 呼ぶのはダッシュボード（`issue-deck-shell.tsx`）で1か所だけ。**済みかどうかの判定は
 * `selectStalePushTags`（純粋関数）へ委ね、ここはブラウザとのやり取りだけを持つ。**
 *
 * **`register`はしない。** Service Workerを登録するのは設定画面だけで（`use-push-delivery.ts`と
 * 同じ作法）、通知を使わない人にも常駐するものを増やさない。登録が無ければ表示中の通知も
 * 無いので、そのまま何もせずに終わる。
 *
 * **閉じられるのはこの端末の通知だけ。** 他の端末に出ているものは、その端末で画面を開くまで
 * 残る——Web Pushの購読は`userVisibleOnly: true`で作っており、「閉じるだけのpush」は
 * 送れないため（#2196）。
 *
 * **iOSアプリ（WKWebView）の通知はAPNsで届き、Service Workerを通らない**（#4250）。
 * アプリ内では`nativePushBridge`越しにネイティブの通知センターを読み・消す（#4921）。
 * 判定は同じ`selectStalePushTags`なので、ブラウザとアプリで消す条件はずれない。
 */

/** 表示中の通知と、それを閉じる手段。取得元ごとの違いはここへ閉じ込める */
type DisplayedNotifications = {
  tags: string[];
  close: (tags: ReadonlySet<string>) => Promise<void>;
};

/** Service Workerが出した通知。対応していない・登録が無いブラウザはnull（＝何もしない） */
async function readServiceWorkerNotifications(): Promise<DisplayedNotifications | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (!registration) return null;
  const notifications = await registration.getNotifications();
  return {
    tags: notifications.map((notification) => notification.tag),
    close: async (stale) => {
      for (const notification of notifications) {
        if (stale.has(notification.tag)) notification.close();
      }
    },
  };
}

/**
 * iOSアプリの通知センターに残っている通知。**この操作を持たない古いビルドでは失敗する**ので、
 * そのときはnull（＝今までどおり残る）にする
 */
async function readNativeNotifications(): Promise<DisplayedNotifications | null> {
  try {
    const tags = await nativePushBridge.deliveredTags();
    if (!Array.isArray(tags)) return null;
    return {
      tags,
      close: (stale) => nativePushBridge.removeDelivered([...stale]),
    };
  } catch {
    return null;
  }
}

function readDisplayedNotifications(): Promise<DisplayedNotifications | null> {
  return isNativeApp() ? readNativeNotifications() : readServiceWorkerNotifications();
}

export type UsePushNotificationCleanupInput = {
  /** 絞り込み前の全Issue。未取得はnull */
  issues: readonly Issue[] | null;
  /** 取得済みのopenなPR一覧。未取得はnull */
  pullRequests: readonly PullRequestSummary[] | null;
  /** PR一覧の取得に失敗したリポジトリ。そこのPRは判断材料が無いので触らない */
  failedRepositories?: readonly string[];
};

export function usePushNotificationCleanup(input: UsePushNotificationCleanupInput): void {
  const { issues, pullRequests, failedRepositories } = input;

  useEffect(() => {
    let cancelled = false;

    const sweep = async () => {
      const displayed = await readDisplayedNotifications();
      if (cancelled || displayed === null || displayed.tags.length === 0) return;
      const stale = new Set(
        selectStalePushTags({
          tags: displayed.tags,
          issues,
          pullRequests,
          failedRepositories,
        }),
      );
      if (stale.size > 0) await displayed.close(stale);
    };

    // 失敗しても画面には何も出さない（消えないだけで、知らせは残る側）
    const run = () => {
      void sweep().catch(() => {});
    };

    run();
    // 別の端末・GitHub上で片付けてから戻ってきたときのために、表に出た時点でも見る。
    // データの取り直しもここで走るが、その結果が届く前の状態でも古いぶんは閉じられる
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // iOSアプリが前面へ戻ったときにSwift側が投げる合図。ブラウザでは飛んでこない
    window.addEventListener(NATIVE_PUSH_REFRESH_EVENT, run);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(NATIVE_PUSH_REFRESH_EVENT, run);
    };
    // Issue一覧のポーリング（10秒ごと）で`issues`が差し替わるたびに走らせる。
    // 中身はローカルの読み取り2回だけで、通信もGitHub APIの消費も増えない
  }, [issues, pullRequests, failedRepositories]);
}
