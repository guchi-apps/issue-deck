import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import { cn } from "@/lib/utils";

/**
 * 自動レビューの判定を画面に出すときの色と記号（#2448・#2843）。
 *
 * **PR詳細の検証結果パネルとマージ確認ダイアログで同じものを使う。** 同じ判定が場所によって
 * 違う色・違う記号で出ると、盤面の色が意味を持たなくなるため、対応表はこの1か所に置く。
 *
 * **`skipped`と`unknown`は灰色で、赤やamberにしない**（#2448）。低リスクかつ小規模なPRで
 * レビューを省くのは設計どおりの動きで（#992のゲート）、判定を取得できなかったのも危険信号では
 * ない。危険信号と同じ色にすると、本当に見るべき`要確認`が埋もれる。
 */
export const REVIEW_TONE: Record<ReviewVerdictKind, string> = {
  ok: "text-green-700 dark:text-green-400",
  "needs-check": "text-amber-700 dark:text-amber-400",
  "changes-requested": "text-destructive",
  skipped: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** 判定の印。色だけに頼らず、記号でも区別できるようにする */
export const REVIEW_MARK: Record<ReviewVerdictKind, string> = {
  ok: "●",
  "needs-check": "▲",
  "changes-requested": "■",
  skipped: "–",
  unknown: "?",
};

/**
 * 判定1つぶんの表示。`count`を渡すと「● 3 問題なし」のように件数つきになる。
 *
 * **件数が0のときは何も出さない。** 内訳の帯に0件の判定まで並べると、見るべき判定を
 * 数字の列から探すことになる。
 */
export function VerdictText({
  kind,
  label,
  count,
  className,
}: {
  kind: ReviewVerdictKind;
  label: string;
  /** 内訳の帯で使う件数。省略すると件数を出さない */
  count?: number;
  className?: string;
}) {
  if (count === 0) return null;

  return (
    <span
      className={cn("flex items-center gap-1.5 whitespace-nowrap", REVIEW_TONE[kind], className)}
    >
      <span aria-hidden="true" className="text-[10px] leading-none">
        {REVIEW_MARK[kind]}
      </span>
      {count !== undefined && <span className="font-semibold tabular-nums">{count}</span>}
      {label}
    </span>
  );
}
