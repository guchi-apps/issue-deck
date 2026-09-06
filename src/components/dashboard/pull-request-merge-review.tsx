"use client";

import { ExternalLink } from "lucide-react";

import { VerdictText } from "@/components/dashboard/review-verdict";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { cn } from "@/lib/utils";

/**
 * マージ確認ダイアログに出す、そのPR1本ぶんのコードレビュー判定（#2843）。
 *
 * **マージを押す直前に、自動レビューが何と言っていたかを読めるようにする場所。** これまで
 * ダイアログにはCI・Auto-merge・本番デプロイの警告しか出ておらず、判定を読むにはPR詳細か
 * GitHubへ戻るしかなかった。
 *
 * 材料はPR本文に残っている`## 検証結果`だけで（`lib/github/pull-request-review-verdict.ts`）、
 * 一覧・詳細のどちらの経路も本文を既に受け取っている。**開いてから取りに行かない**ので、
 * 「このリリースに含まれる変更」と違って読み込み待ちが無い。
 *
 * **指摘の本文はここに置かない。** 何を指摘されたのかまで並べると、判断より先にダイアログが
 * 長くなる。ここは「見過ごした指摘が無いか」を確かめる場所にとどめ、本文はPR詳細のパネル
 * （`VerificationSummaryPanel`）とGitHubのレビューコメントへ譲る。
 *
 * **記録が無いことも出す。** 判定が読めないPR（自動レビューを持たないリポジトリ・レビューが
 * まだ走っていないPR）で何も出さないと、「問題なし」と「まだ誰も見ていない」が同じ見た目に
 * なる。灰色で「記録がありません」と書く——危険信号ではないので赤やamberにはしない。
 */
export function PullRequestMergeReview({
  verdict,
  htmlUrl,
  className,
}: {
  /** そのPRの判定。記録が無ければnull */
  verdict: PullRequestReviewVerdict | null;
  /** レビューコメントを読みに行く先（PRのURL）。渡さない画面では導線を出さない */
  htmlUrl?: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="text-xs font-semibold">コードレビュー</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">PR本文の記録から</span>
      </div>

      {verdict === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          レビューの記録がありません（自動レビューを持たないリポジトリのPRか、判定がまだ書かれていません）。
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 px-3 py-2 text-xs">
            <div className="flex items-center gap-2.5">
              <dt className="w-28 shrink-0 text-muted-foreground">自動レビュー</dt>
              <dd className="min-w-0">
                <VerdictText kind={verdict.reviewKind} label={verdict.reviewLabel} />
              </dd>
            </div>
            <div className="flex items-center gap-2.5">
              <dt className="w-28 shrink-0 text-muted-foreground">機械的リスク判定</dt>
              <dd className="min-w-0">
                <span
                  className={cn(
                    "whitespace-nowrap",
                    verdict.riskKind === "hit"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {verdict.riskLabel}
                </span>
              </dd>
            </div>
            {verdict.riskReasons.length > 0 && (
              <ul className="list-disc pl-[8.25rem] text-[11px] text-muted-foreground">
                {verdict.riskReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {verdict.confirmLabel && (
              <div className="flex items-center gap-2.5">
                <dt className="w-28 shrink-0 text-muted-foreground">ユーザーの確認</dt>
                <dd className="min-w-0">{verdict.confirmLabel}</dd>
              </div>
            )}
          </dl>

          {htmlUrl && (
            <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
              <span>判定の根拠はこのPRのレビューコメントにあります</span>
              <a
                href={htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex shrink-0 items-center gap-1 text-foreground hover:underline"
              >
                レビューを読む
                <ExternalLink aria-hidden className="size-3" />
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
