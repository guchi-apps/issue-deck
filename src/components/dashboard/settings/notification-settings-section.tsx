"use client";

import { Bell, Laptop, Send, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import { describePushDevice } from "@/lib/push-client";

/**
 * 設定の「通知」区分（#838）。**PCの設定ダイアログとスマホの設定画面が同じものを描く。**
 *
 * 置いてあるのは「この端末で受け取るかどうか」だけで、リポジトリ単位・種別単位のON/OFFは
 * 持たない。通知するのは確認待ち（`00.check-user`）1種類なので、増やすなら種類が増えてから。
 *
 * **「押せない」で終わらせない。** iOSはホーム画面に追加しないと受け取れず、一度
 * 「許可しない」を選ぶとこの画面からは尋ね直せない。どちらも画面の外でしか直せないため、
 * 何をすればよいかを必ず添える。
 */
export function NotificationSettingsSection() {
  const {
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
  } = usePushSubscription(true);

  const isSubscribed = deliveryState === "delivering";
  // **失効（ブラウザには購読が残っているのにサーバー側の行が無い）を「オフ」と混ぜない**
  // （#2196）。どちらも受け取っていないが、失効はこちらから消したものではなく、
  // ユーザーがやることも「登録し直す」で違う
  // 操作中（登録し直している最中など）は出さない。一覧を取り直すまでのわずかな間、
  // ブラウザ側だけが新しい購読を持つ状態になり、そこで「失効」が一瞬光る
  const isExpired = !isLoading && !isSubmitting && deliveryState === "expired";
  const notConfigured = !isLoading && publicKey === null;
  const isDenied = permission === "denied";
  const canSubscribe = availability === "available" && !notConfigured && !isDenied;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">確認待ちのPush通知</p>
        <p className="text-xs text-muted-foreground">
          担当リポジトリのIssueに<code className="font-mono">00.check-user</code>
          が付いたとき、この端末へ通知します。アプリを開いているあいだも同じように通知するので、
          他のアプリを見ているときにも気づけます。受け取っているあいだは画面内のお知らせを
          出さないため、二重になることはありません。
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex items-center gap-2.5">
          <Bell
            className={`size-4 shrink-0 ${isSubscribed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">この端末</p>
            <p className="truncate text-xs text-muted-foreground">
              {isLoading
                ? "確認しています…"
                : isSubscribed
                  ? "通知を受け取っています"
                  : isExpired
                    ? "購読が失効しています"
                    : "通知を受け取っていません"}
            </p>
          </div>
          <span
            className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              isSubscribed
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {isSubscribed
              ? "受け取り中"
              : notConfigured
                ? "利用できません"
                : isExpired
                  ? "失効"
                  : "オフ"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {isSubscribed ? (
            <>
              <Button variant="outline" onClick={unsubscribe} disabled={isSubmitting}>
                受け取りを止める
              </Button>
              <Button variant="ghost" onClick={sendTest} disabled={isSubmitting}>
                <Send />
                テスト通知を送る
              </Button>
            </>
          ) : (
            <Button onClick={subscribe} disabled={!canSubscribe || isSubmitting || isLoading}>
              <Bell />
              {isExpired ? "登録し直す" : "この端末で受け取る"}
            </Button>
          )}
        </div>

        {!isSubscribed && !isExpired && canSubscribe && (
          <p className="text-xs text-muted-foreground">
            押すとブラウザが通知の許可を尋ねます。許可はこの端末・このブラウザにだけ効きます。
          </p>
        )}
        {isExpired && (
          <p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <b className="font-semibold">この端末の購読は失効しています。</b>
            送ろうとしたときに宛先が無くなっていたため、登録を削除しました。「登録し直す」を押すと
            取り直せます。登録し直すまでは、アプリを開いているあいだの確認待ちを画面内のお知らせで
            伝えます。
          </p>
        )}
        {isSubscribed && (
          <p className="text-xs text-muted-foreground">
            テスト通知は、この画面を開いたままでもOSの通知として表示されます。しばらく待っても
            出てこない場合は、端末側の設定でIssueDeckの通知が許可されているかを確かめてください。
          </p>
        )}
        {message && <p className="text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {availability === "needs-standalone" && (
        <p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <b className="font-semibold">ホーム画面に追加すると受け取れます。</b>
          iPhone・iPadは、ホーム画面のアイコンから開いているときだけ通知を受け取れます。
          共有ボタンから「ホーム画面に追加」で開き直してから、もう一度この画面を開いてください
          （iOS 16.4以降が必要です）。
        </p>
      )}

      {availability === "unsupported" && (
        <p className="rounded-md border bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          このブラウザはPush通知に対応していません。別のブラウザで開くか、ホーム画面に追加した
          アプリから開いてください。
        </p>
      )}

      {isDenied && (
        <p className="rounded-md border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
          <b className="font-semibold">通知がブロックされています。</b>
          一度「許可しない」を選ぶと、この画面からは尋ね直せません。端末の設定の「通知」から
          IssueDeckを許可してください。
        </p>
      )}

      {notConfigured && !isLoading && (
        <p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <b className="font-semibold">サーバー側の鍵が設定されていません。</b>
          Push通知に使う鍵（VAPID）が未設定のため、この機能はまだ使えません。設定するまで、
          他の機能には影響しません。
        </p>
      )}

      {subscriptions !== null && subscriptions.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-4">
          <p className="text-sm font-medium">通知を受け取っている端末</p>
          <p className="text-xs text-muted-foreground">
            他の端末で登録した通知もここに並びます。使わなくなった端末はここから外せます。
          </p>
          <ul className="mt-1.5 flex flex-col overflow-hidden rounded-lg border">
            {subscriptions.map((subscription) => {
              const isCurrent = subscription.endpointKey === currentEndpointKey;
              const label = describePushDevice(subscription.userAgent);
              const Icon = /iPhone|iPad|Android/.test(label) ? Smartphone : Laptop;
              return (
                <li
                  key={subscription.id}
                  className="flex items-center gap-2.5 border-b p-2.5 last:border-b-0"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {label}
                      {isCurrent && (
                        <span className="ml-1.5 text-xs text-muted-foreground">（この端末）</span>
                      )}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={formatDateTimeFull(subscription.createdAt)}
                    >
                      {formatDateTime(subscription.createdAt)} に登録
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto shrink-0"
                    onClick={() => removeSubscription(subscription.id)}
                    disabled={isSubmitting}
                  >
                    解除
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
