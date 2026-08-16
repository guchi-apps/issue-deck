import { cn } from "@/lib/utils";

/**
 * メニューの件数の強調の度合い（#1796）。**強調するのは件数だけで、行の背景・ラベル文字・
 * アイコンは通常のまま置く**（#1443）。行全体を塗ると選択中の行と見分けがつかなくなる。
 *
 * - `none` … 通常（グレーの数字）
 * - `attention` … 塗りつぶしの丸。**「人が動くまで進まないもの」だけ**（確認待ち・作業待ち）
 * - `unread` … 数字の文字色だけ変える。要対応より一段弱い強調で、質問の未確認に使う。
 *   質問は読めば済むもので、放置しても盤面は止まらない。同じ丸バッジにすると、上から順に
 *   手を動かせば進む、という並びの読み方が崩れる
 */
export type NavCountEmphasis = "none" | "attention" | "unread";

/**
 * 左メニュー（PC・`sidebar-nav.tsx`）とホームのメニュー（スマホ・`mobile-home-screen.tsx`）で
 * 共通の件数表示。**見た目を1か所に置く**——同じ強調を2つのファイルに書くと、片方だけ
 * 直された時点でPCとスマホで意味が食い違う。
 */
export function NavCount({
  count,
  emphasis = "none",
}: {
  /** null・未指定なら何も出さない */
  count?: number | null;
  emphasis?: NavCountEmphasis;
}) {
  if (count === null || count === undefined) return null;
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground",
        emphasis === "attention" &&
          "flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-white",
        emphasis === "unread" && "font-semibold text-amber-600 dark:text-amber-400",
      )}
    >
      {count}
    </span>
  );
}
