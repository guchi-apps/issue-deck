"use client";

import { RefreshCw } from "lucide-react";

import { useNow } from "@/hooks/use-now";
import { describeRefreshButtonHint } from "@/lib/auto-refresh";
import { describeRefreshStatus, type RefreshTone } from "@/lib/refresh-status";
import { cn } from "@/lib/utils";

/**
 * 古さの配色（#1773）。ホストの使用率・チェックアウトの鮮度（`dispatch-host-panel.tsx`）と
 * 同じ色を同じ意味で使う。
 */
const TONE_CLASS: Record<RefreshTone, string> = {
  normal: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
};

/**
 * いつ時点の内容かを出し、押すと取り直すボタン（#1773で実行キューに入れ、#1909で通知ベルとも
 * 共通化した）。
 *
 * **経過の数え上げ（1秒ごと）をこのボタンだけに閉じ込めるため、独立したコンポーネントに
 * してある。** 置いた側で`useNow`を呼ぶと、そのポップオーバー・シート全体が毎秒描き直される。
 * **ポップオーバー・シートは閉じている間そもそも描かれない**ので、この毎秒の更新が走るのは
 * 開いている間だけ。
 *
 * **回転の条件は「取得中」で、自動更新でも回す**（#1767と同じ）。自動で取り直しているのに
 * 何も動かないと、止まっているのか取りに行っているのかが見分けられない。
 */
export function RefreshIndicatorButton({
  fetchedAt,
  isFetching,
  pollIntervalMs,
  onRefresh,
  label,
  className,
}: {
  /** 最後に取得できた時刻（epoch ms）。まだ一度も取れていなければ`null` */
  fetchedAt: number | null;
  isFetching: boolean;
  /** 自動更新の間隔。文言（「30秒ごと」）と古さの判定に使う */
  pollIntervalMs: number;
  onRefresh: () => void;
  /** スクリーンリーダー向けの名前（例:「実行キューを今すぐ更新」）。何を更新するのかを含める */
  label: string;
  className?: string;
}) {
  const now = useNow(1_000);
  const { label: text, tone } = describeRefreshStatus({
    fetchedAt,
    nowMs: now,
    isFetching,
    pollIntervalMs,
  });

  return (
    <button
      type="button"
      aria-label={label}
      title={describeRefreshButtonHint(pollIntervalMs)}
      className={cn(
        // 秒が変わるたびに文字幅が動かないよう桁を固定する
        "flex items-center gap-1 rounded px-1 py-0.5 text-[11px] tabular-nums hover:bg-accent hover:text-foreground",
        TONE_CLASS[tone],
        className,
      )}
      onClick={onRefresh}
    >
      <RefreshCw className={cn("size-3 shrink-0", isFetching && "animate-spin")} />
      {text}
    </button>
  );
}
