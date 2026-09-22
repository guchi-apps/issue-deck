"use client";

import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { ReviewVerdictFreshnessNote, VerdictText } from "@/components/dashboard/review-verdict";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import { cn } from "@/lib/utils";

/**
 * developへマージする直前に出す、自動レビューの指摘（#2849）。
 *
 * **置き場所はPR詳細**（#3333）。#2914ではIssue詳細の対応PRセクションにも修正依頼欄と一緒に
 * 置いていたが、PRへの操作（マージ・修正依頼）をPR詳細へ一本化したため、ここだけになった。
 *
 * **判定だけを出すマージ確認ダイアログ（`PullRequestMergeReview`・#2843）の続き。** あちらは
 * 「見過ごした指摘が無いか」を確かめる場所で、指摘の本文は意図して置いていない。こちらは
 * **その指摘を読んで、直させるかどうかを決める場所**なので本文を出す。
 *
 * **本文は既定で開いておく。** リリースPRの検証結果（`VerificationSummaryPanel`）が既定で
 * 閉じているのは10件以上が並ぶためで、ここは1件しか出ない。閉じておくと、指摘があることに
 * 気付かないままマージを押せてしまう。
 */
export function PullRequestReviewFindings({
  review,
  pullRequestNumber,
  pullRequestUrl,
  reviewRunUrl,
  className,
}: {
  /** 読み取れたレビュー。記録が無ければnull（下の「記録がありません」を出す） */
  review: PullRequestReviewCommentContent | null;
  /** そのレビューが付いているPR番号。見出しに使う */
  pullRequestNumber: number;
  /** PRのURL。レビューコメントのURLが取れないときの「GitHubで読む」の行き先 */
  pullRequestUrl?: string;
  /** レビューが実行中・失敗などで、コメント本文より先に実行状況を確認したいときの行き先 */
  reviewRunUrl?: string | null;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const readUrl = review?.htmlUrl ?? reviewRunUrl ?? pullRequestUrl ?? null;

  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/50 px-3 py-2">
        <span className="shrink-0 text-xs font-semibold">コードレビュー</span>
        {review && (
          <VerdictText
            kind={review.verdictKind}
            label={review.verdictLabel}
            className="shrink-0 text-xs"
          />
        )}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {review
            ? `PR #${pullRequestNumber} のレビューコメントから · ${formatRelativeDate(review.createdAt)}`
            : `PR #${pullRequestNumber}`}
        </span>
      </div>

      {review === null ? (
        /* **「指摘が無い」と「誰も本文を残していない」を同じ見た目にしない**（#2843の
           マージ確認ダイアログと同じ考え方）。ローカルのレビュー・統合セッションが見たPRは
           判定をPR本文の`## 検証結果`へ書き、PRコメントには判定マーカーを付けないため、
           レビュー済みでもここは空になる（`scripts/prompts/review-agent.md`）。
           危険信号ではないので灰色で書き、読みに行く先だけ示す */
        <p className="px-3 py-2 text-xs text-muted-foreground">
          レビュー本文の記録がありません（低リスクで省略されたか、判定だけがPR本文に残る経路で
          レビューされています）。指摘があるかはPRのコメントで確かめてください。
        </p>
      ) : (
        <>
          {/* 古いコミットへのレビューであることは、本文より先に言う（#2849）。追いコミットの後に
              出す指摘は、既に直っている可能性がある */}
          {review.isStale && (
            <ReviewVerdictFreshnessNote
              className="rounded-none border-b px-3 py-2 ring-0"
              freshness="stale"
              reviewedSha={review.reviewedSha}
            />
          )}

          <div className="px-3 py-2">
            <button
              type="button"
              onClick={() => setIsOpen((prev) => !prev)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={isOpen}
            >
              {isOpen ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
              レビュー本文
            </button>
            {isOpen && (
              <div className="mt-1 max-h-64 overflow-y-auto">
                <MarkdownBody content={review.body} className="text-xs" />
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/50 px-3 py-1.5">
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {/* 修正依頼の入口はPR詳細上部の帯（`PullRequestFixIssueBar`）。押すと指摘を引用した
              依頼文・下書きが開く（#3009・#3333） */}
          指摘を直させるときは、画面上部の「修正を依頼」「修正Issueを起案」から送ります。
        </span>
        {readUrl && (
          <a
            href={readUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground hover:underline"
          >
            {reviewRunUrl && review?.htmlUrl === null ? "レビューの実行ログを開く" : "GitHubで読む"}
            <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
      </div>
    </div>
  );
}
