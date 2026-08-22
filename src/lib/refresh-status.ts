import { autoRefreshIntervalLabel } from "@/lib/auto-refresh";

/**
 * 「いま出ている内容がいつ時点のものか」を出す更新インジケーターの文言と配色
 * （#1773で実行キューに入れたものを、通知ベルと共通化した。#1909）。
 *
 * **自動で取り直している画面ほど、止まっていることに気づけない。** 取得の失敗は握り潰す作りで、
 * バックグラウンドタブでは取得自体を飛ばすため、内容が古いまま固まっていても正常時と見分けが
 * 付かない。
 *
 * **出すのは「最後に取れた時刻」と「次に取りに行く間隔」の2つだけ。** 間隔は画面ごとに違う
 * （実行キューは5秒／20秒、通知ベルは30秒）ので、固定文ではなく呼び出し側が実際に使っている値を
 * 受け取って出す。
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
export type RefreshTone = "normal" | "warn";

/**
 * 取得できていないと見なすまでの倍率（#1773）。
 *
 * 20秒間隔なら1分、5秒間隔なら15秒。1回や2回の取りこぼしは自動で追い付くので、
 * 3周ぶん落ちて初めて色を変える。
 */
const STALE_INTERVAL_FACTOR = 3;

export function describeRefreshStatus({
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
}): { label: string; tone: RefreshTone } {
  // 間隔の言い方は画面のヘッダー（`describeAutoRefreshState`）と同じ「◯秒間隔」にそろえる
  // （#1797）。同じものを画面ごとに違う言い方で出さない
  const interval = autoRefreshIntervalLabel(pollIntervalMs);

  // まだ一度も取れていないとき（初回の取得中・SSR直後）は経過を出しようがない。
  // 「0秒前に更新」のような、取れていないのに取れたように読める表示を出さない
  if (isFetching || fetchedAt === null || nowMs === null) {
    return { label: "更新中…", tone: "normal" };
  }

  const elapsedMs = Math.max(0, nowMs - fetchedAt);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const tone: RefreshTone =
    elapsedMs > pollIntervalMs * STALE_INTERVAL_FACTOR ? "warn" : "normal";

  if (elapsedSeconds < 1) return { label: `たった今更新・${interval}`, tone };
  if (elapsedSeconds < 60) return { label: `${elapsedSeconds}秒前に更新・${interval}`, tone };

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return { label: `${elapsedMinutes}分前に更新・${interval}`, tone };

  return { label: `${Math.floor(elapsedMinutes / 60)}時間前に更新・${interval}`, tone };
}
