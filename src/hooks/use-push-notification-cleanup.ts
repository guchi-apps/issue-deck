"use client";

import { useEffect } from "react";

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
 */

/** 表示中の通知のタグを引く。対応していない・登録が無いブラウザはnull（＝何もしない） */
async function readDisplayedNotifications(): Promise<Notification[] | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (!registration) return null;
  return registration.getNotifications();
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
      const notifications = await readDisplayedNotifications();
      if (cancelled || notifications === null || notifications.length === 0) return;
      const stale = new Set(
        selectStalePushTags({
          tags: notifications.map((notification) => notification.tag),
          issues,
          pullRequests,
          failedRepositories,
        }),
      );
      for (const notification of notifications) {
        if (stale.has(notification.tag)) notification.close();
      }
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

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // Issue一覧のポーリング（10秒ごと）で`issues`が差し替わるたびに走らせる。
    // 中身はローカルの読み取り2回だけで、通信もGitHub APIの消費も増えない
  }, [issues, pullRequests, failedRepositories]);
}
