/**
 * 「この端末の購読が変わった」を同じページの中で伝えるための合図（#2196）。
 *
 * 購読の登録・解除は設定画面（`use-push-subscription.ts`）で行うが、その結果で
 * 出し方が変わるのはダッシュボード側（`use-push-delivery.ts`）で、両者は親子ではない。
 * **状態を上へ持ち上げるより、ブラウザのイベントを1本通す方が軽い**——判定に要る材料は
 * どちらもブラウザとサーバーから引き直せるので、渡すものは何も無い。
 */

const PUSH_SUBSCRIPTION_CHANGED_EVENT = "issue-deck:push-subscription-changed";

/** 購読を登録・解除した側が呼ぶ */
export function notifyPushSubscriptionChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_CHANGED_EVENT));
}

/** 受け取る側が呼ぶ。戻り値は購読を外す関数 */
export function onPushSubscriptionChanged(listener: () => void): () => void {
  window.addEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, listener);
}
