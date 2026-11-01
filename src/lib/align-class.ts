/**
 * 作業状況カード内の部品が共有する配置指定（#5165）。
 *
 * `responsive`は、スマホ（md未満）では右寄せの縦積みのまま、PC・iPad（md以上）では
 * 左起点にする。右寄せのままだとPC幅で左側が空くため。`start`/`end`の挙動は変えない。
 */
export type Align = "start" | "end" | "responsive";

export const ALIGN_CLASS: Record<Align, { items: string; justify: string; text: string }> = {
  start: { items: "items-start", justify: "justify-start", text: "text-left" },
  end: { items: "items-end", justify: "justify-end", text: "text-right" },
  responsive: {
    items: "items-end md:items-start",
    justify: "justify-end md:justify-start",
    text: "text-right md:text-left",
  },
};
