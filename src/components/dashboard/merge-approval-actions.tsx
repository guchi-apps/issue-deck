"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";

import { ApprovalTextField } from "@/components/dashboard/approval-text-field";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { PullRequestReviewFindings } from "@/components/dashboard/pull-request-review-findings";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import {
  buildReviewFixRequestText,
  type PullRequestReviewCommentContent,
} from "@/lib/github/pull-request-review-comment";
import { cn } from "@/lib/utils";

/**
 * マージ待ちのIssueで「読んで決める」ための一式——自動レビューの本文と修正依頼欄（#2914）。
 *
 * **置き場所は画面上部の対応PRセクションの中で、コメント欄の承認カードではない。** 以前は
 * コメント一覧の末尾（`comment-thread.tsx`の`ApprovalActions`）にあり、上部の対応PRセクションと
 * 同じPRの行・同じ「自動マージされなかった理由」がその上に重なっていた。読む場所と押す場所が
 * 2か所に割れていたので、**マージボタンがある側**へ寄せ、コメント欄には「対応PRへ移動」だけを残す。
 *
 * **「指摘を修正依頼に取り込む」はGitHubへ何も送らない。** 押すと下の修正依頼欄が引用で埋まる
 * だけで、送るのは人が「修正を依頼する」を押したとき（#2849）。取り込む文面は
 * `buildReviewFixRequestText`が持つ。
 *
 * 出すものが1つも無ければ（レビューの取得中で、かつ修正依頼も送れない）何も描かない。
 */
export function MergeApprovalActions({
  review = null,
  reviewPullRequestNumber = null,
  isLoadingReview = false,
  pullRequestLinks,
  repositoryFullName,
  issueSuggestions,
  onRequestPrFix,
  isRequestingPrFix = false,
  className,
}: {
  /** 対応PRへ投稿された自動レビューの本文。記録が無い・取得前はnull */
  review?: PullRequestReviewCommentContent | null;
  /** `review`が付いているPR番号。nullならレビューのカードを出さない */
  reviewPullRequestNumber?: number | null;
  /**
   * レビュー本文の取得がまだ終わっていないか。**終わるまでカードを描かない**——取得前は
   * `review`が必ずnullになるため、そのまま描くと「記録がありません」を一瞬出してから
   * 本文へ差し替わる。
   */
  isLoadingReview?: boolean;
  /** 対応PRへのリンク。「GitHubで読む」の行き先に使う */
  pullRequestLinks?: PullRequestLink[];
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  /** 「修正を依頼する」の処理。渡さない場合は修正依頼欄を出さない */
  onRequestPrFix?: (reason: string) => Promise<void> | void;
  isRequestingPrFix?: boolean;
  className?: string;
}) {
  const [prFixReason, setPrFixReason] = useState("");
  const [prFixValidationError, setPrFixValidationError] = useState<string | null>(null);
  const [isPrFixTextUploading, setIsPrFixTextUploading] = useState(false);
  // レビューの指摘を取り込んだか（#2849）。ボタンの文言を「もう一度取り込む」へ変えるだけで、
  // 取り込みを1回に制限はしない（書きかけを消して入れ直したい場合がある）
  const [hasImportedReview, setHasImportedReview] = useState(false);

  const showReview = reviewPullRequestNumber !== null && !isLoadingReview;
  if (!showReview && !onRequestPrFix) return null;

  function changePrFixReason(value: string) {
    setPrFixReason(value);
    setPrFixValidationError(null);
  }

  /**
   * レビューの指摘を修正依頼欄へ取り込む（#2849）。**GitHubへは何も送らない。**
   * 入るのはこの欄までで、どの指摘を直させるかは引用から削って決める。
   *
   * **既に書いてあるものは消さずに後ろへ足す。** 自分で書きかけた依頼が消えると、
   * 打ち直しになる（入力中のフォームを初期化し直さない、と同じ考え方）。
   */
  function importReviewFindings() {
    if (!review || reviewPullRequestNumber === null) return;
    const imported = buildReviewFixRequestText({ review, pullRequestNumber: reviewPullRequestNumber });
    setPrFixReason((prev) => (prev.trim() === "" ? imported : `${prev.trimEnd()}\n\n${imported}`));
    setPrFixValidationError(null);
    setHasImportedReview(true);
  }

  async function submitPrFix() {
    if (!onRequestPrFix) return;
    if (!prFixReason.trim()) {
      setPrFixValidationError("修正内容を入力してください");
      return;
    }
    await onRequestPrFix(prFixReason);
    setPrFixReason("");
    setPrFixValidationError(null);
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* 自動レビューが何を指摘したのかを、マージを押す前に読める位置へ出す（#2849・#2914）。
          **PRの行の下・修正依頼欄の上**に置く——読んでから「マージする」「修正を依頼する」の
          どちらを押すかを決める場所なので、判断材料が2つのボタンの間に来る */}
      {showReview && (
        <PullRequestReviewFindings
          review={review}
          pullRequestNumber={reviewPullRequestNumber}
          pullRequestUrl={
            pullRequestLinks?.find((link) => link.number === reviewPullRequestNumber)?.url
          }
          onImport={onRequestPrFix ? importReviewFindings : undefined}
          isImported={hasImportedReview}
        />
      )}
      {onRequestPrFix && (
        <>
          <Separator className="my-1" />
          <div className="flex flex-col gap-2">
            <ApprovalTextField
              value={prFixReason}
              onChange={changePrFixReason}
              placeholder="修正依頼を入力（必須）"
              repositoryFullName={repositoryFullName}
              issueSuggestions={issueSuggestions}
              disabled={isRequestingPrFix}
              onUploadingChange={setIsPrFixTextUploading}
            />
            {prFixValidationError && (
              <p className="text-sm text-destructive">{prFixValidationError}</p>
            )}
            <div className="flex items-center gap-2">
              {/* 取り込んだ内容がそのまま送られることを、送る直前に一度言う（#2849） */}
              {hasImportedReview && (
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  レビュー指摘を取り込みました。この内容がそのままエージェントへ渡ります。
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto shrink-0"
                onClick={submitPrFix}
                disabled={isRequestingPrFix || isPrFixTextUploading}
              >
                <Pencil />
                修正を依頼する
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
