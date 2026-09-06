"use client";

import { Loader2 } from "lucide-react";

import {
  CODE_REVIEW_SEVERITIES,
  describeCodeReviewSeverity,
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

/**
 * 一覧の行に出すレビュー結果（#2855）。
 *
 * **開かずに「重いものが何件あるか」だけ読めるようにする場所。** 指摘の中身・「Issueを作成」は
 * 今までどおりIssue詳細の`CodeReviewPanel`が持つ。
 *
 * 結果がまだ無い行も黙って空にしない——「レビュー中」なのか、指摘が0件だったのかは、
 * どちらもバッジが無い状態と見分けが付かない。
 */
export function CodeReviewResultBadges({ summary }: { summary: CodeReviewSummary }) {
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
    </>
  );
}
