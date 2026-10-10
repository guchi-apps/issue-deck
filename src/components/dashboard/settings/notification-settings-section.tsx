"use client";

import { Bell, Laptop, Send, Smartphone } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useNativePush } from "@/hooks/use-native-push";
import { usePushKindPreferences } from "@/hooks/use-push-kind-preferences";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import { PUSH_KIND_LABELS, PUSH_KINDS } from "@/lib/notifications/push-kinds";
import { isNativeApp, type NativePushState } from "@/lib/native-push";
import { describePushDevice } from "@/lib/push-client";

/**
 * 設定の「通知」区分（#838）。**PCの設定ダイアログとスマホの設定画面が同じものを描く。**
 *
 * 「この端末で受け取るか」（購読）と、「どの種類を受け取るか」（#4159。ユーザー単位で、
 * 端末をまたいで効く）の2層。種類をOFFにしても購読は残るので、ONに戻せばすぐ届く。
 *
 * **「押せない」で終わらせない。** iOSはホーム画面に追加しないと受け取れず、一度
 * 「許可しない」を選ぶとこの画面からは尋ね直せない。どちらも画面の外でしか直せないため、
 * 何をすればよいかを必ず添える。
 */
function WebPushSettings() {
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
        <p className="text-sm font-medium">Push通知</p>
        <p className="text-xs text-muted-foreground">
          確認待ち・本番マージ待ち・リリース完了・デプロイ起動漏れを、この端末へ通知します。
          アプリを開いているあいだも同じように通知するので、他のアプリを見ているときにも
          気づけます。受け取っているあいだは画面内のお知らせを出さないため、二重になることは
          ありません。
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

      <PushKindPreferences />

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

const subscribeNothing = () => () => {};

/**
 * iOSアプリ内かどうかでWeb Push向けとネイティブ向けを出し分ける（#4275）。サーバー描画では
 * 常にWeb側として扱い、クライアントで判定する（Hydrationの食い違いを避ける）。
 */
export function NotificationSettingsSection() {
  const isNative = useSyncExternalStore(subscribeNothing, () => isNativeApp(), () => false);
  return isNative ? <NativePushSettings /> : <WebPushSettings />;
}

const NATIVE_STATE_LABEL: Record<NativePushState, { text: string; badge: string }> = {
  checking: { text: "確認しています…", badge: "確認中" },
  on: { text: "通知を受け取っています", badge: "オン" },
  off: { text: "通知を受け取っていません", badge: "オフ" },
  denied: { text: "iPhoneの設定で通知が許可されていません", badge: "許可なし" },
  registering: { text: "登録できていません。登録しています…", badge: "登録中" },
  expired: { text: "登録が失効しています", badge: "失効" },
};

/** iOSアプリ内の通知欄。許可・受信設定・サーバー登録から「この端末」の状態を決める */
function NativePushSettings() {
  const { state, isSubmitting, error, message, turnOn, turnOff, openSettings, sendTest, refresh } =
    useNativePush(true);
  const isOn = state === "on";
  const label = NATIVE_STATE_LABEL[state];
  // 確認中・登録中・拒否済みはスイッチを動かさない（不明な状態を操作させない）
  const canToggle = !isSubmitting && (state === "on" || state === "off" || state === "expired" || state === "registering");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Push通知</p>
        <p className="text-xs text-muted-foreground">
          確認待ち・本番マージ待ち・リリース完了・デプロイ起動漏れを、この端末へ通知します。
          オン・オフはこの端末だけに効き、他の端末や通知の種類の設定は変わりません。
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex items-center gap-2.5">
          <Bell className={`size-4 shrink-0 ${isOn ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">この端末</p>
            <p className="text-xs text-muted-foreground">{label.text}</p>
          </div>
          <span
            className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              isOn
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {label.badge}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isOn}
            aria-label="この端末のプッシュ通知"
            disabled={!canToggle}
            onClick={isOn ? turnOff : turnOn}
            className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              isOn ? "bg-emerald-600" : "bg-muted-foreground/40"
            }`}
          >
            <span
              className={`absolute top-[2px] size-[18px] rounded-full bg-white transition-all ${
                isOn ? "left-[18px]" : "left-[2px]"
              }`}
            />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {state === "expired" && (
            <Button onClick={turnOn} disabled={isSubmitting}>
              <Bell />
              登録し直す
            </Button>
          )}
          {state === "denied" && (
            <Button variant="outline" onClick={openSettings}>
              iPhoneの設定を開く
            </Button>
          )}
          {isOn && (
            <Button variant="ghost" onClick={sendTest} disabled={isSubmitting}>
              <Send />
              テスト通知を送る
            </Button>
          )}
          {error && (
            <Button variant="outline" onClick={refresh} disabled={isSubmitting}>
              状態を再取得
            </Button>
          )}
        </div>

        {state === "denied" && (
          <p className="rounded-md border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
            <b className="font-semibold">iPhoneの設定で通知がオフになっています。</b>
            アプリからは許可を変えられません。「iPhoneの設定を開く」から「通知」でIssueDeckを許可してください。
            戻ってくると状態を自動で確かめます。
          </p>
        )}
        {state === "off" && (
          <p className="text-xs text-muted-foreground">
            オンにすると、まだ選んでいなければiPhoneが通知の許可を尋ねます。
          </p>
        )}
        {state === "expired" && (
          <p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <b className="font-semibold">この端末の登録は失効しています。</b>
            送ろうとしたときに宛先が無くなっていたため、登録を削除しました。「登録し直す」で取り直せます。
          </p>
        )}
        {isOn && (
          <p className="text-xs text-muted-foreground">
            オンは、この端末で通知の許可と登録が済んでいる状態です（届くことの保証ではありません）。
            テスト通知が出ない場合は、iPhoneの設定でIssueDeckの通知を確かめてください。
          </p>
        )}
        {message && <p className="text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <PushKindPreferences />
    </div>
  );
}

/** 受け取る通知の種類（アカウント共通）。Web・iOSアプリのどちらの通知欄でも同じものを出す */
function PushKindPreferences() {
  const kindPreferences = usePushKindPreferences(true);

  return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">受け取る通知の種類</p>
        <p className="text-xs text-muted-foreground">
          オフにした種類は届きません。設定はアカウント全体に効き、登録した全端末で共通です。
          テスト通知はこの設定に関係なく届きます。
        </p>
        <ul className="mt-1.5 flex flex-col overflow-hidden rounded-lg border">
          {PUSH_KINDS.map((kind) => {
            const checked = kindPreferences.value?.[kind] ?? true;
            const { title, description } = PUSH_KIND_LABELS[kind];
            return (
              <li key={kind} className="flex items-center gap-3 border-b p-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{title}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  aria-label={`${title}の通知`}
                  disabled={kindPreferences.value === null}
                  onClick={() => kindPreferences.setKindEnabled(kind, !checked)}
                  className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    checked ? "bg-emerald-600" : "bg-muted-foreground/40"
                  }`}
                >
                  <span
                    className={`absolute top-[2px] size-[18px] rounded-full bg-white transition-all ${
                      checked ? "left-[18px]" : "left-[2px]"
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
        {kindPreferences.value?.["check-user"] === false && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            確認待ちをオフにしていると、止まったIssueに気づけなくなります。
          </p>
        )}
        {kindPreferences.error && <p className="text-xs text-destructive">{kindPreferences.error}</p>}
      </div>
  );
}
