"use client";

import { Info, Pencil } from "lucide-react";
import { useState } from "react";

import { ApprovalTextField } from "@/components/dashboard/approval-text-field";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { PullRequestReviewFindings } from "@/components/dashboard/pull-request-review-findings";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  PR_FIX_SESSION_INSTRUCTION,
  prFixRequestActionLabel,
  type PrFixRequestRoute,
} from "@/lib/dispatch/pr-fix-request";
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
 * **修正依頼の送り先は1つではない**（#2919）。`11.local`が付いている間、`@claude`コメントを
 * 投稿しても無人実行は`mode=skip`で断るだけなので、送り先（`route`）に合わせて案内とボタンの
 * 文言を変える。どこへ何が送られるのかは、押す前にこの欄で読める。判定は
 * `resolvePrFixRequestRoute`が持ち、押したあとの処理は呼び出し側（Issue詳細）にある。
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
  prFixRoute = { kind: "actions" },
  prFixSessionRejection = null,
  prFixSessionError = null,
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
  /**
   * 修正依頼の送り先（#2919）。既定は従来どおりの無人実行。
   *
   * **判定材料はIssueのラベルとセッションの状態**で、ここでは決めない
   * （`resolvePrFixRequestRoute`）。この欄が受け取るのは結果だけ。
   */
  prFixRoute?: PrFixRequestRoute;
  /**
   * サブPCへ積めない理由（#2919。`prFixRoute`が`session`・`resume`のときだけ意味がある）。
   *
   * **ボタンごと消さず、理由を出して押せなくする**（`SessionRecoveryButton`と同じ立場）。
   * 判定と文言は既存のものをそのまま使う——`session`は追加指示と同じ
   * `resolveSessionControlRejection`、`resume`は起動ジョブと同じ`resolveDispatchTargetRejection`。
   */
  prFixSessionRejection?: string | null;
  /**
   * サブPCへ積むところで失敗した理由（#2919）。押した**後**に出るもので、
   * `prFixSessionRejection`と違いボタンは押せるままにする（書き直して送り直せる）。
   *
   * **黙って落とさない。** 依頼のコメントは投稿されているので、ここで何も出さないと
   * 「コメントは増えたのにセッションは知らない」という、この画面がいちばん避けたい状態になる。
   */
  prFixSessionError?: string | null;
  className?: string;
}) {
  const [prFixReason, setPrFixReason] = useState("");
  const [prFixValidationError, setPrFixValidationError] = useState<string | null>(null);
  const [isPrFixTextUploading, setIsPrFixTextUploading] = useState(false);
  // レビューの指摘を取り込んだか（#2849）。ボタンの文言を「もう一度取り込む」へ変えるだけで、
  // 取り込みを1回に制限はしない（書きかけを消して入れ直したい場合がある）
  const [hasImportedReview, setHasImportedReview] = useState(false);

  const showReview = reviewPullRequestNumber !== null && !isLoadingReview;
  // 送れない理由が意味を持つのはサブPCへ積む2つの送り先だけ（#2919）。無人実行・引き継ぎは
  // GitHubへの操作なので、サブPCが落ちていようと押せる
  const sessionBlocked =
    (prFixRoute.kind === "session" || prFixRoute.kind === "resume") &&
    prFixSessionRejection !== null;
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
            {/* どこへ送られるのかを、書き始める前に出す（#2919）。無人実行が担当のIssueでは
                今までどおり何も出さない（送り先が1つしかなく、言うことが無い） */}
            <PrFixRouteNotice
              route={prFixRoute}
              rejection={prFixSessionRejection}
              error={prFixSessionError}
            />
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
                disabled={isRequestingPrFix || isPrFixTextUploading || sessionBlocked}
              >
                <Pencil />
                {prFixRequestActionLabel(prFixRoute)}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 修正依頼がどこへ送られるのかを、書き始める前に出す（#2919）。
 *
 * **無人実行が担当のときは何も出さない。** 送り先が1つしかない状態で「無人実行へ送ります」と
 * 言っても、読む人が確かめられることが増えない（今までどおりの画面のままにする）。
 *
 * ローカル担当のときだけ出し、**呼び戻すこと・ラベルを外すこと・固定の1行を流すことを押す前に
 * 書く。** 黙って`11.local`が外れると、後から無人実行が動き出した理由を画面から辿れなくなる。
 */
function PrFixRouteNotice({
  route,
  rejection,
  error,
}: {
  route: PrFixRequestRoute;
  /** 送れない理由（`session`・`resume`のときだけ意味がある） */
  rejection: string | null;
  /** 送信そのものが失敗した理由（押した後に出る） */
  error: string | null;
}) {
  if (route.kind === "actions") return null;

  const hostName = route.kind === "handoff" ? null : formatDispatchHostName(route.host);

  return (
    <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {route.kind === "session" ? (
            <>
              このIssueは{hostName}の
              <strong className="font-medium">セッションが担当中</strong>です（
              <code>11.local</code>が付いている間、無人実行は修正依頼に反応しません）。
              依頼はIssueコメントとして残したうえで、走っているセッションへ知らせます。
            </>
          ) : route.kind === "resume" ? (
            <>
              このIssueを担当していた{hostName}のセッションは
              <strong className="font-medium">終了しています</strong>
              。依頼を投稿したうえで、
              <strong className="font-medium">前回の会話の続きから再開</strong>
              します（worktreeはそのまま・<code>11.local</code>も付いたまま）。
            </>
          ) : (
            <>
              このIssueには<code>11.local</code>が付いていますが、
              <strong className="font-medium">セッションの記録が見当たりません</strong>
              （24時間で消えます）。呼び戻す先が無いので、ラベルを外してから依頼を投稿し、
              無人実行（GitHub Actions）が既存のPull Requestを直せるようにします。
            </>
          )}
        </span>
      </p>
      {/* 送る1行は固定で、押した人が書いた文面はコメントの側に入る（docs/multi-agent/gates.md）。
          何が飛ぶのかを押す前に全文で出す */}
      {route.kind === "session" && (
        <p className="mt-1.5 pl-5">セッションへ送る1行: 「{PR_FIX_SESSION_INSTRUCTION}」</p>
      )}
      {route.kind !== "handoff" && (rejection ?? error) && (
        <p className="mt-1.5 pl-5 text-destructive">{rejection ?? error}</p>
      )}
    </div>
  );
}
