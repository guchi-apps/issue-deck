/**
 * 実行キューの更新インジケーターの文言と配色（#1773）。
 *
 * **実行キューは開いている間ずっと自動で取り直しているが、その形跡が画面に無かった。**
 * 取得の失敗は握り潰す作り（`use-dispatch-state.ts`）で、バックグラウンドタブでは取得自体を
 * 飛ばすため、内容が古いまま固まっていても正常時と見分けが付かない。
 *
 * **出すのは「最後に取れた時刻」と「次に取りに行く間隔」の2つだけ。** 間隔は動いているジョブの
 * 有無で5秒／20秒に変わるので、固定文ではなくフックが実際に使っている値を受け取って出す。
 *
 * **次の更新までのカウントダウンは出さない。** 知りたいのは「出ている内容がいつ時点のものか」で、
 * あと何秒で更新されるかではない。
 */

/**
 * 古さの配色（#1773）。ホストの使用率（`host-metrics.ts`）・チェックアウトの鮮度
 * （`host-checkout.ts`）と同じ段階の色使いに揃える。画面の中で同じ色が違う重さを指さないため、
 * ここでは`critical`（赤）を使わない——**赤はジョブの失敗とホストの応答なしに割り当ててあり、
 * 「ブラウザが取りに行けていない」を同じ重さで出すと取り違える。**
 */
export type DispatchQueueRefreshTone = "normal" | "warn";

/**
 * 取得できていないと見なすまでの倍率（#1773）。
 *
 * 20秒間隔なら1分、5秒間隔なら15秒。1回や2回の取りこぼしは自動で追い付くので、
 * 3周ぶん落ちて初めて色を変える。
 */
const STALE_INTERVAL_FACTOR = 3;

export function describeDispatchQueueRefresh({
  fetchedAt,
  nowMs,
  isFetching,
  pollIntervalMs,
}: {
  /** 最後に取得できた時刻（epoch ms）。まだ一度も取れていなければ`null` */
  fetchedAt: number | null;
  /** 現在時刻（epoch ms）。`useNow`はマウント前に`null`を返す */
  nowMs: number | null;
  isFetching: boolean;
  pollIntervalMs: number;
}): { label: string; tone: DispatchQueueRefreshTone } {
  const interval = `${Math.round(pollIntervalMs / 1000)}秒ごと`;

  // まだ一度も取れていないとき（初回の取得中・SSR直後）は経過を出しようがない。
  // 「0秒前に更新」のような、取れていないのに取れたように読める表示を出さない
  if (isFetching || fetchedAt === null || nowMs === null) {
    return { label: "更新中…", tone: "normal" };
  }

  const elapsedMs = Math.max(0, nowMs - fetchedAt);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const tone: DispatchQueueRefreshTone =
    elapsedMs > pollIntervalMs * STALE_INTERVAL_FACTOR ? "warn" : "normal";

  if (elapsedSeconds < 1) return { label: `たった今更新・${interval}`, tone };
  if (elapsedSeconds < 60) return { label: `${elapsedSeconds}秒前に更新・${interval}`, tone };

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return { label: `${elapsedMinutes}分前に更新・${interval}`, tone };

  return { label: `${Math.floor(elapsedMinutes / 60)}時間前に更新・${interval}`, tone };
}

/** ボタンのツールチップ（#1773）。押すと何が起きるかと、放っておいても更新されることの両方を出す */
export function describeDispatchQueueRefreshHint(pollIntervalMs: number): string {
  return `今すぐ更新（${Math.round(pollIntervalMs / 1000)}秒ごとに自動更新）`;
}
