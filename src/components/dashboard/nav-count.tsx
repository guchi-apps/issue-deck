import { cn } from "@/lib/utils";

/**
 * メニューの件数の強調の度合い（#1796）。**強調するのは件数だけで、行の背景・ラベル文字・
 * アイコンは通常のまま置く**（#1443）。行全体を塗ると選択中の行と見分けがつかなくなる。
 *
 * - `none` … 通常（グレーの数字）
 * - `attention` … 塗りつぶしのオレンジの丸。**人が手を動かすまで進まないもの**
 *   （確認待ち・作業待ち）と、**回答が届いていてまだ読んでいない質問**（#1910）に使う
 *
 * **弱い強調（数字の文字色だけ変える`unread`）は#1910で廃止した。** 質問は読めば済むので
 * 一段弱く出す（#1796）としていたが、数字の色だけでは未確認の回答があることに気づけず、
 * 見落としの原因になっていた。強調の段階を1つにして、**丸が点いている行は上から順に
 * 手を動かせば消える**という読み方へ揃える。
 *
 * **丸の中の数字は「いま手を動かせる数」とは限らない**（#2070）。「質問」の行だけは、
 * 数字が一覧に並ぶ件数（開いている質問の総数）で、丸は「未確認の回答がある」という合図として
 * 点く。#1910では数字も未確認の件数にしていたが、読み終えた質問しか無いと、質問が何件も
 * 開いたままでも`0`と出て「質問は無い」と読めていた。内訳は行の吹き出し
 * （`formatQuestionNavTitle`）と一覧ヘッダー（`formatQuestionListCount`）で読む。
 */
export type NavCountEmphasis = "none" | "attention";

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
      )}
    >
      {count}
    </span>
  );
}
