"use client";

import { ChevronDown, ChevronRight, CornerDownLeft, ExternalLink } from "lucide-react";
import { useState } from "react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { VerdictText } from "@/components/dashboard/review-verdict";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import { cn } from "@/lib/utils";

/**
 * developへマージする直前に出す、自動レビューの指摘（#2849）。
 *
 * **置き場所はIssue詳細の上部、対応PRセクションの中**（#2914。`MergeApprovalActions`が
 * 修正依頼欄と一緒に描く）。マージボタンと同じ枠に置くのは、**古いコミットへの警告
 * （`isStale`）や指摘を読まないままマージを押せる位置に置かない**ため。以前はコメント一覧の
 * 末尾（承認カード）にあり、上部の対応PRセクションと同じPRの行がその上に重なっていた。
 *
 * **判定だけを出すマージ確認ダイアログ（`PullRequestMergeReview`・#2843）の続き。** あちらは
 * 「見過ごした指摘が無いか」を確かめる場所で、指摘の本文は意図して置いていない。こちらは
 * **その指摘を読んで、直させるかどうかを決める場所**なので本文を出す。
 *
 * **「修正依頼に取り込む」はGitHubへ何も送らない。** 押すと下の修正依頼欄が引用で埋まるだけで、
 * 送るのは人が「修正を依頼する」を押したとき。指摘のうちどれを直させるかは、引用から不要な行を
 * 削って決める（リリース前の「修正をIssueにする」が、押しても起票せず埋めたダイアログを開く
 * だけなのと同じ立場。#2838）。
 *
 * **本文は既定で開いておく。** リリースPRの検証結果（`VerificationSummaryPanel`）が既定で
 * 閉じているのは10件以上が並ぶためで、ここは1件しか出ない。閉じておくと、指摘があることに
 * 気付かないままマージを押せてしまう。
 */
export function PullRequestReviewFindings({
  review,
  pullRequestNumber,
  pullRequestUrl,
  onImport,
  isImported,
  className,
}: {
  /** 読み取れたレビュー。記録が無ければnull（下の「記録がありません」を出す） */
  review: PullRequestReviewCommentContent | null;
  /** そのレビューが付いているPR番号。見出しと取り込む文面に使う */
  pullRequestNumber: number;
  /** PRのURL。レビューコメントのURLが取れないときの「GitHubで読む」の行き先 */
  pullRequestUrl?: string;
  /**
   * 指摘を修正依頼欄へ取り込む。渡さない場合は取り込みボタンを出さない
   * （マージ済み・修正依頼を送れない画面向け）。
   */
  onImport?: () => void;
  /** 既に取り込み済みか。押し直せるが、文言で「済み」だと分かるようにする */
  isImported?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const readUrl = review?.htmlUrl ?? pullRequestUrl ?? null;

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
            <p className="border-b bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
              このレビューの後にコミットが積まれています（レビュー時点:{" "}
              <code className="font-mono">{review.reviewedSha?.slice(0, 7)}</code>
              ）。指摘が既に直っている可能性があります。
            </p>
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
          {review
            ? "指摘を下の修正依頼へ引用で取り込みます。送る前に不要な行を削れます。"
            : "修正させたい内容は、下の修正依頼欄へ書いて送れます。"}
        </span>
        {readUrl && (
          <a
            href={readUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground hover:underline"
          >
            GitHubで読む
            <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
        {review && onImport && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onImport}>
            <CornerDownLeft />
            {isImported ? "もう一度取り込む" : "指摘を修正依頼に取り込む"}
          </Button>
        )}
      </div>
    </div>
  );
}
