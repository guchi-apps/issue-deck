"use client";

import { REVIEW_MARK, REVIEW_TONE } from "@/components/dashboard/review-verdict";
import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import type {
  MergePrecheck,
  MergePrecheckLevel,
  MergePrecheckOverall,
} from "@/lib/pull-request-merge-precheck";
import { cn } from "@/lib/utils";

/**
 * 状態と記号・色の対応は自動レビュー判定の表（`review-verdict.tsx`）を借りる。
 * 同じ●▲■が場所によって違う色で出ると、盤面の色が意味を持たなくなるため。
 * `neutral`は判定の対象外で、`skipped`と同じ灰色の`–`にする
 */
const LEVEL_KIND: Record<MergePrecheckLevel, ReviewVerdictKind> = {
  ok: "ok",
  warn: "needs-check",
  bad: "changes-requested",
  neutral: "skipped",
};

const OVERALL_KIND: Record<MergePrecheckOverall, ReviewVerdictKind> = {
  ok: "ok",
  warn: "needs-check",
  bad: "changes-requested",
  pending: "skipped",
};

const OVERALL_BACKGROUND: Record<MergePrecheckOverall, string> = {
  ok: "bg-green-50 dark:bg-green-950/40",
  warn: "bg-amber-50 dark:bg-amber-950/40",
  bad: "bg-red-50 dark:bg-red-950/40",
  pending: "bg-muted/40",
};

/**
 * マージ確認ダイアログの「マージ前の確認」（#3093）。mainへのPRでしか出さない。
 *
 * 押した瞬間に本番デプロイが走るマージなのに、ダイアログにはCIが落ちているとき以外は
 * PR番号と変更一覧しか出ず、本当に出してよいかを別の画面で確かめていた。CI・コンフリクト・
 * Claudeのレビューを総合判定つきの1枚にまとめ、最後の画面だけで決められるようにする。
 *
 * **判定はマージを止めない。** 材料を並べるだけで、最終判断は人が行う。
 * 色だけに頼らず、記号（● ▲ ■ –）でも区別する。幅が狭い画面では、行の名前と結果を2段に積む。
 */
export function PullRequestMergePrecheck({ precheck }: { precheck: MergePrecheck }) {
  return (
    <div className="overflow-hidden rounded-lg border text-left">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="text-xs font-semibold">マージ前の確認</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          画面を開いた時点の状態
        </span>
      </div>

      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 text-[13px] font-bold",
          OVERALL_BACKGROUND[precheck.overall],
          REVIEW_TONE[OVERALL_KIND[precheck.overall]],
        )}
      >
        <span aria-hidden="true" className="text-[11px] leading-none">
          {REVIEW_MARK[OVERALL_KIND[precheck.overall]]}
        </span>
        {precheck.headline}
      </div>

      <ul>
        {precheck.rows.map((row) => {
          const kind = LEVEL_KIND[row.level];
          return (
            <li
              key={row.id}
              className="grid grid-cols-[1rem_1fr] items-baseline gap-x-2 gap-y-0.5 border-b px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[1rem_8.5rem_1fr]"
            >
              <span
                aria-hidden="true"
                className={cn("text-[11px] leading-none", REVIEW_TONE[kind])}
              >
                {REVIEW_MARK[kind]}
              </span>
              <span className="font-semibold">{row.label}</span>
              <span className={cn("col-start-2 min-w-0 sm:col-start-auto", REVIEW_TONE[kind])}>
                <span className="font-bold">{row.summary}</span>
                {row.detail && (
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        この判定でマージは止まりません。最終判断はあなたが行います。
      </div>
    </div>
  );
}
