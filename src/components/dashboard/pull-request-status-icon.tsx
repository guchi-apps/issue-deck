import { Check, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";

/** アイコンで描く状態。それ以外（実施中・—など）は文字のまま出す。 */
export type PullRequestStatusIconKind = "done" | "needs-check" | "failed";

const ICON: Record<
  PullRequestStatusIconKind,
  { symbol: string; title: string; Icon: typeof Check; className: string }
> = {
  done: {
    symbol: "✔",
    title: "完了",
    Icon: Check,
    className: "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950",
  },
  "needs-check": {
    symbol: "△",
    title: "要確認",
    Icon: Minus,
    className: "bg-amber-600 text-white dark:bg-amber-400 dark:text-amber-950",
  },
  failed: {
    symbol: "×",
    title: "要修正",
    Icon: X,
    className: "bg-red-600 text-white dark:bg-red-400 dark:text-red-950",
  },
};

/**
 * PRの判定（CI・コンフリクト・レビュー）の完了・要確認・要修正を描く色付きの丸。
 *
 * 以前は✔を文字で描き色を付けていたが、iPhoneではこの文字が色指定の効かない黒い字形で
 * 出て、完了が読み取りにくかった（#3681）。そこでSVGの丸アイコンにする。元の記号は
 * 画面外テキストとして残し、読み上げと文字としての取得を保つ。
 */
export function PullRequestStatusIcon({
  kind,
  className,
}: {
  kind: PullRequestStatusIconKind;
  className?: string;
}) {
  const { symbol, title, Icon, className: tone } = ICON[kind];
  return (
    <span
      className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full", tone, className)}
      title={title}
    >
      <Icon className="size-3" strokeWidth={3.5} aria-hidden="true" />
      <span className="sr-only">{symbol}</span>
    </span>
  );
}

/** 状態がアイコンで描くものならその種別を返す。 */
export function toStatusIconKind(state: string): PullRequestStatusIconKind | null {
  return state === "done" || state === "needs-check" || state === "failed" ? state : null;
}
