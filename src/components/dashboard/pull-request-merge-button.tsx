"use client";

import { useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { PullRequestMergeProduction } from "@/components/dashboard/pull-request-merge-production";
import { PullRequestMergeReview } from "@/components/dashboard/pull-request-merge-review";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import {
  ciWarning,
  isMergeJudgementPending,
  isProductionMerge,
  MERGE_JUDGEMENT_PENDING_LABEL,
  mergeJudgementReason,
  mergeWarnings,
} from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

type PullRequestMergeButtonProps = {
  pullRequest: PullRequestSummary;
  onMerged: () => void;
  className?: string;
  /** 詳細ペインでは主要な操作なので塗りつぶし、一覧では控えめな枠線にする */
  variant?: "default" | "outline";
};

/**
 * PRをissue-deckの画面からマージするボタン（#1058・#1087）。
 *
 * CIが落ちている・実行中・Auto-merge待ちといった「そのまま押すと意図とずれうる」状態では
 * 確認ダイアログを挟む（`mergeWarnings`）。CI通過済みで待ちが無いPRは1クリックでマージする。
 * **mainへのPRは常に確認を挟む**——`mergeWarnings`が本番デプロイが走る旨の警告を必ず返すため（#1548）。
 *
 * マージが通ったあとは「マージ済み」で無効のまま残す（#1548）。`onMerged`で再取得を促しても、
 * 一覧が入れ替わるまでの数秒はボタンが押せる状態で残り、そこを押すと2回目のマージ要求が飛ぶ
 * （GitHubは405で弾くが、画面にはエラーだけが出る）。
 *
 * **mainへのPRでは、確認ダイアログに「マージ前の確認」と「このリリースに含まれる変更」を
 * 並べる**（#2080・#3093。`PullRequestMergeProduction`）。本番デプロイが走るマージなのに、
 * ダイアログにはPR番号とブランチ名しか出ておらず、何を出そうとしているのかも、出してよいのかも
 * その場では分からなかった。CI・コンフリクト・Claudeのレビューは「マージ前の確認」が出すので、
 * 警告リストからはCIの1件だけを外す（同じ内容が二重に並ぶため。`mergeWarnings`自体は変えない
 * ——確認ダイアログを開くかどうかの判定に使っている）。
 *
 * **mainへのPR以外では、そのPR1本ぶんのレビュー判定を出す**（#2843。`PullRequestMergeReview`）。
 * `mergeWarnings`が「要修正」「要確認」でも警告を返すようになったため、CIが通っていて待ちの
 * 無いPRでも、指摘が残っていればここを通る。
 *
 * **自動マージ可否の判定中は「判定中」で無効にする**（#1968。`isMergeJudgementPending`）。
 * 判定のcheck-runはCI状態の集約から外れている（#1799）ため、そこを塞がないと判定より先に
 * 確認なしでマージできてしまう。
 */
export function PullRequestMergeButton({
  pullRequest,
  onMerged,
  className,
  variant = "outline",
}: PullRequestMergeButtonProps) {
  const { mergePullRequest, isSubmitting, error } = usePullRequestMergeMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isMerged, setIsMerged] = useState(false);
  const warnings = mergeWarnings(pullRequest);
  // 本番デプロイが走るマージだけ、何を出そうとしているのかをダイアログの中で出す（#2080）
  const productionMerge = isProductionMerge(pullRequest);
  // 「マージ前の確認」がCIの状態を出すので、mainのときは警告リストのCIの項目を外す（#3093）
  const ciWarningText = productionMerge ? ciWarning(pullRequest) : null;
  const shownWarnings = warnings.filter((warning) => warning !== ciWarningText);
  const judgementPending = isMergeJudgementPending(pullRequest.mergeJudgement);
  const [owner, repo] = pullRequest.repositoryFullName.split("/");

  async function runMerge() {
    const merged = await mergePullRequest({ owner, repo, number: pullRequest.number });
    setConfirmOpen(false);
    if (merged) {
      setIsMerged(true);
      onMerged();
    }
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {error && <span className="truncate text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant={variant}
        className="h-7 shrink-0"
        disabled={isSubmitting || isMerged || judgementPending}
        title={judgementPending ? mergeJudgementReason(pullRequest.mergeJudgement.step) : undefined}
        onClick={() => (warnings.length > 0 ? setConfirmOpen(true) : runMerge())}
      >
        {isMerged
          ? "マージ済み"
          : isSubmitting
            ? "マージ中..."
            : judgementPending
              ? MERGE_JUDGEMENT_PENDING_LABEL
              : "マージする"}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        {/* 変更点を並べるぶん、mainへのPRのときだけ広げる。中身が増えても画面からはみ出さない
            よう、高さの上限とスクロールはどちらの幅でも付ける（スマホで下端が切れる） */}
        <AlertDialogContent
          className={cn("max-h-[90dvh] overflow-y-auto", productionMerge && "sm:max-w-lg")}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>このPRをマージしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pullRequest.repositoryFullName} #{pullRequest.number}（{pullRequest.headRef} →{" "}
              {pullRequest.baseRef}）をマージします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {shownWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {productionMerge ? (
            <PullRequestMergeProduction pullRequest={pullRequest} open={confirmOpen} />
          ) : (
            <PullRequestMergeReview
              verdict={pullRequest.reviewVerdict}
              htmlUrl={pullRequest.htmlUrl}
              headSha={pullRequest.headSha}
              isReviewing={judgementPending}
            />
          )}
          <ApiErrorMessage message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 確認結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する。
                event.preventDefault();
                runMerge();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "マージ中..." : "マージする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
