"use client";

import { Loader2 } from "lucide-react";

import {
  CODE_REVIEW_SEVERITIES,
  describeCodeReviewFindingProgress,
  describeCodeReviewSeverity,
  type CodeReviewFindingProgress,
  type CodeReviewSeverity,
  type CodeReviewSummary,
} from "@/lib/github/code-review";
import { cn } from "@/lib/utils";

/**
 * 重要度のバッジ。**重大はdestructive、中は`00.check-user`と同じamber、軽微はニュートラル**で、
 * 盤面で既に意味を持っている色から外れないようにする（#698）。
 *
 * 一覧の行（#2855）とIssue詳細のレビュー結果パネルが同じものを使う。片方に書くと、
 * 同じ「重大」が場所によって違う色で出る。
 */
export function CodeReviewSeverityBadge({
  severity,
  count,
  className,
}: {
  severity: CodeReviewSeverity;
  count?: number;
  className?: string;
}) {
  const tone: Record<CodeReviewSeverity, string> = {
    high: "border-destructive/30 bg-destructive/10 text-destructive",
    medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    low: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
        tone[severity],
        className,
      )}
    >
      {describeCodeReviewSeverity(severity)}
      {count !== undefined && ` ${count}`}
    </span>
  );
}

/** 対応状況チップの共通の形。重要度バッジと同じ高さ・字送りに揃える */
const PROGRESS_BADGE_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums";

/**
 * 指摘の対応状況（#2868）。**「重大1・中3・軽微2」だけでは、その指摘を起案し終えたのか、
 * まだ手つかずなのかが行から読めない**ため、件数の隣に進み具合を出す。
 *
 * 出し分けは3通り。**1件も起票していないレビューだけ文言を変える**——`0/6`と出すより
 * 「これから起案する」ことがそのまま読める。
 *
 * - 起票が1件も無い: `未起票 6件`（枠は破線。「結果なし」と同じく、まだ何も無いことを表す）
 * - 途中: `対応 2/6` ＋ 3色のバー（完了=emerald／起票済み=amber／未起票=border）
 * - 全部close済み: `対応済み 2/2`（emerald。読み返す必要が無い行だと一目で分かるようにする）
 *
 * 色は前提条件の進み具合（`manual-step-prerequisites.tsx`）と同じ使い分けにしてある。
 */
export function CodeReviewProgressBadge({
  progress,
  className,
}: {
  progress: CodeReviewFindingProgress;
  className?: string;
}) {
  if (progress.total === 0) return null;

  // ホバー・読み上げでは内訳まで読めるようにする。行に出す文字は3つの数字に絞る
  const detail = describeCodeReviewFindingProgress(progress);

  if (progress.created === 0) {
    return (
      <span
        className={cn(PROGRESS_BADGE_CLASS, "border-dashed text-muted-foreground", className)}
        title={detail}
        aria-label={detail}
      >
        {`未起票 ${progress.total}件`}
      </span>
    );
  }

  if (progress.resolved === progress.total) {
    return (
      <span
        className={cn(
          PROGRESS_BADGE_CLASS,
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          className,
        )}
        title={detail}
        aria-label={detail}
      >
        {`対応済み ${progress.resolved}/${progress.total}`}
      </span>
    );
  }

  // 起票したがまだopenのぶん。emerald（対応済み）とborder（未起票）の間に挟む
  const inProgress = progress.created - progress.resolved;
  return (
    <span
      className={cn(PROGRESS_BADGE_CLASS, "text-muted-foreground", className)}
      title={detail}
      aria-label={detail}
    >
      <span className="flex h-1 w-[30px] overflow-hidden rounded-full bg-border" aria-hidden="true">
        {progress.resolved > 0 && (
          <span className="bg-emerald-500" style={{ flex: progress.resolved }} />
        )}
        {inProgress > 0 && <span className="bg-amber-500" style={{ flex: inProgress }} />}
      </span>
      {`対応 ${progress.resolved}/${progress.total}`}
    </span>
  );
}

/**
 * 一覧の行に出すレビュー結果（#2855）。
 *
 * **開かずに「重いものが何件あるか」「どこまで片付いたか」だけ読めるようにする場所。**
 * 指摘の中身・「Issueを作成」は今までどおりIssue詳細の`CodeReviewPanel`が持つ。
 *
 * 結果がまだ無い行も黙って空にしない——「レビュー中」なのか、指摘が0件だったのかは、
 * どちらもバッジが無い状態と見分けが付かない。
 */
export function CodeReviewResultBadges({
  summary,
  progress,
}: {
  summary: CodeReviewSummary;
  /**
   * 指摘の対応状況（#2868）。**数えるのは呼び出し側**——引き当て先が絞り込み前の全Issueで、
   * ここには渡ってこないため（`summarizeCodeReviewFindingProgress`）。渡さなければ出さない。
   */
  progress?: CodeReviewFindingProgress | null;
}) {
  if (summary.state === "pending") {
    return (
      <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
        <Loader2 className="size-2.5 animate-spin" />
        レビュー中
      </span>
    );
  }

  // 依頼コメントも結果コメントも無いレビューIssue（手で立てたものなど）。
  // 「指摘なし」と同じ見た目にすると、読んで指摘が無かったのと区別が付かない
  if (summary.state === "missing") {
    return (
      <span className="rounded-full border border-dashed px-2 py-0.5 text-[10px] text-muted-foreground">
        結果なし
      </span>
    );
  }

  if (summary.findingCount === 0) {
    return (
      <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
        指摘なし
      </span>
    );
  }

  return (
    <>
      {CODE_REVIEW_SEVERITIES.filter((severity) => summary.counts[severity] > 0).map((severity) => (
        <CodeReviewSeverityBadge
          key={severity}
          severity={severity}
          count={summary.counts[severity]}
        />
      ))}
      {/* 対応状況は重要度の**後ろ**に置く（#2868）。行を開くかどうかは重いものが何件あるかで
          決めるもので、進み具合はその次に読む */}
      {progress && <CodeReviewProgressBadge progress={progress} />}
    </>
  );
}
