"use client";

import { useState } from "react";

import { GitMerge, Loader2 } from "lucide-react";

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
import { MERGE_JUDGEMENT_UNKNOWN, type MergeJudgement } from "@/lib/github/check-rollup";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import {
  isMergeJudgementPending,
  MERGE_JUDGEMENT_PENDING_LABEL,
  mergeJudgementReason,
} from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";

type IssueMergeButtonProps = {
  /** マージを実行する。成功したらtrueを返す */
  onMerge: () => Promise<boolean> | boolean;
  /** マージ成功時に呼ぶ。画面内のもう一方のマージボタンも「マージ済み」へ切り替えるため親へ通知する */
  onMerged?: () => void;
  /** 対応PR番号。確認ダイアログの文面に使う。取得できない場合はnull */
  pullRequestNumber?: number | null;
  /** 対応PRの最新コミットのCI状態。実行中はマージさせない */
  ciStatus?: PullRequestCiStatus | null;
  /**
   * 自動マージ可否の判定の進み具合（#1968）。`pending`のあいだはマージさせない。
   * CI状態とは別の軸で、判定のcheck-runはCI状態の集約から外れている（#1799）。
   */
  mergeJudgement?: MergeJudgement | null;
  isMerging?: boolean;
  isMerged?: boolean;
  /** マージ失敗時のエラーメッセージ。ボタンの手前にインライン表示する */
  error?: string | null;
  className?: string;
};

/**
 * Issue画面から対応PRをマージするボタン（#1288）。
 *
 * 置き場所は対応PR一覧（`issue-pull-request-list.tsx`）の各行の中だけで、Issue画面には
 * その一覧が2箇所（本文の上・コメント欄のマージ待ちカード）出る（#1339）。マージ済みかどうかは
 * 呼び出し側が持ち、どちらから押しても両方が「マージ済み」になるようにする。
 *
 * PR一覧・PR詳細画面のマージボタンは`PullRequestMergeButton`（`pull-request-merge-button.tsx`）で、
 * `PullRequestSummary`を前提に警告付きの確認を出す別物。Issue画面はPR番号しか持たないためこちらを使う。
 *
 * **CI実行中に加えて、自動マージ可否の判定中も押せなくする**（#1968。`mergeJudgement`）。
 * 判定のcheck-runはCI状態の集約から外れている（#1799）ため、`ciStatus`だけを見ていると
 * 判定より先にマージできてしまう。
 */
export function IssueMergeButton({
  onMerge,
  onMerged,
  pullRequestNumber,
  ciStatus,
  mergeJudgement,
  isMerging,
  isMerged,
  error,
  className,
}: IssueMergeButtonProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const busy = Boolean(isMerging);
  const merged = Boolean(isMerged);
  const judgementPending = isMergeJudgementPending(mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN);
  const disabled = busy || merged || ciStatus === "in_progress" || judgementPending;

  async function confirmMerge() {
    const ok = await onMerge();
    setIsConfirmOpen(false);
    if (ok) onMerged?.();
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {error && <span className="truncate text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        onClick={() => setIsConfirmOpen(true)}
        disabled={disabled}
        title={judgementPending ? mergeJudgementReason(mergeJudgement?.step ?? null) : undefined}
        // CIバッジの出現とdisabled化が同一レンダーで重なると、バッジ挿入によるレイアウトの
        // 横移動とopacityのtransition-all（既定）が競合し、モバイルSafariで旧位置の
        // ボタンが一瞬二重表示される（#1115）。opacityを含む全プロパティのtransitionを
        // やめ、色関連のみに絞ることで回避する。
        className="transition-colors"
      >
        {busy ? <Loader2 className="animate-spin" /> : <GitMerge />}
        {merged
          ? "マージ済み"
          : judgementPending
            ? MERGE_JUDGEMENT_PENDING_LABEL
            : "マージする"}
      </Button>

      <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull Requestをマージしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pullRequestNumber != null ? `対応PR #${pullRequestNumber}を` : "対応PRを"}
              マージコミットでdevelopへマージします。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMerge} disabled={busy}>
              マージする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
