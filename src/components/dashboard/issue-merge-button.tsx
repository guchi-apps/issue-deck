"use client";

import { useState } from "react";

import { GitMerge, GitPullRequestClosed, Loader2 } from "lucide-react";

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
import type { MergeJudgement } from "@/lib/github/check-rollup";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import {
  isMergeJudgementPending,
  MERGE_JUDGEMENT_PENDING_LABEL,
  mergeJudgementReason,
} from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";

/** 対応PRの状態を取得している最中のボタンの文言（#2352） */
export const DETAIL_PENDING_LABEL = "確認中";

const DETAIL_PENDING_TITLE =
  "対応PRのCI・マージ判定の状態を確認しています。確認が終わると押せるようになります。";

type IssueMergeButtonProps = {
  /** マージを実行する。成功したらtrueを返す */
  onMerge: () => Promise<boolean> | boolean;
  /** マージ成功時に呼ぶ。画面内のもう一方のマージボタンも「マージ済み」へ切り替えるため親へ通知する */
  onMerged?: () => void;
  /**
   * PRをマージせずにクローズし、Issueも「対応終了」としてクローズする（#2780「マージしない」）。
   * 成功したらtrueを返す。省略すると「マージしない」ボタン自体を出さない
   * （PR詳細画面など、Issueと紐付いていない呼び出し元向け）。
   */
  onDecline?: () => Promise<boolean> | boolean;
  /** クローズ成功時に呼ぶ */
  onDeclined?: () => void;
  /** 対応PR番号。確認ダイアログの文面に使う。取得できない場合はnull */
  pullRequestNumber?: number | null;
  /** 対応PRの最新コミットのCI状態。実行中はマージさせない */
  ciStatus?: PullRequestCiStatus | null;
  /**
   * 自動マージ可否の判定の進み具合（#1968）。`pending`のあいだはマージさせない。
   * CI状態とは別の軸で、判定のcheck-runはCI状態の集約から外れている（#1799）。
   */
  mergeJudgement?: MergeJudgement | null;
  /**
   * 対応PRの状態（CI・マージ判定）をまだ取得できていないか（#2352）。trueのあいだは
   * 「確認中」で押せなくする。取得が終わるまで押せる「マージする」を出していると、
   * 直後にバッジが合流して「判定中」へ変わるまでの数秒が誤操作の窓になる。
   */
  isDetailPending?: boolean;
  isMerging?: boolean;
  isMerged?: boolean;
  /** 「マージしない」の実行中・実行済み（#2780）。マージとは別の状態として持つ */
  isDeclining?: boolean;
  isDeclined?: boolean;
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
 *
 * **その状態を取りに行っている最中も押せなくする**（#2352。`isDetailPending`）。CI・判定は
 * PR番号とは別のリクエストで後から届くため、届くまでのあいだ`ciStatus`も`mergeJudgement`も
 * nullになる。nullを「待つものが無い」と読むと、押せる「マージする」を先に出したうえで
 * 数秒後に「判定中」へ変わることになり、その窓で誤って押せてしまう。
 */
export function IssueMergeButton({
  onMerge,
  onMerged,
  onDecline,
  onDeclined,
  pullRequestNumber,
  ciStatus,
  mergeJudgement,
  isDetailPending,
  isMerging,
  isMerged,
  isDeclining,
  isDeclined,
  error,
  className,
}: IssueMergeButtonProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeclineConfirmOpen, setIsDeclineConfirmOpen] = useState(false);
  const busy = Boolean(isMerging);
  const declineBusy = Boolean(isDeclining);
  const merged = Boolean(isMerged);
  const declined = Boolean(isDeclined);
  const judgementPending = isMergeJudgementPending(mergeJudgement);
  const detailPending = Boolean(isDetailPending) && !merged && !declined;
  const disabled =
    busy || declineBusy || merged || declined || detailPending || ciStatus === "in_progress" || judgementPending;
  // 「マージしない」はCI・判定の結果を問わない却下なので、その2つでは塞がない
  // （CIが落ちている・判定中のPRこそ却下したいことがある）。マージ中・クローズ中・取得中だけ塞ぐ
  const declineDisabled = busy || declineBusy || merged || declined || detailPending;

  async function confirmMerge() {
    const ok = await onMerge();
    setIsConfirmOpen(false);
    if (ok) onMerged?.();
  }

  async function confirmDecline() {
    if (!onDecline) return;
    const ok = await onDecline();
    setIsDeclineConfirmOpen(false);
    if (ok) onDeclined?.();
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {error && <span className="truncate text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        onClick={() => setIsConfirmOpen(true)}
        disabled={disabled}
        title={
          detailPending
            ? DETAIL_PENDING_TITLE
            : judgementPending
              ? mergeJudgementReason(mergeJudgement?.step ?? null)
              : undefined
        }
        // CIバッジの出現とdisabled化が同一レンダーで重なると、バッジ挿入によるレイアウトの
        // 横移動とopacityのtransition-all（既定）が競合し、モバイルSafariで旧位置の
        // ボタンが一瞬二重表示される（#1115）。opacityを含む全プロパティのtransitionを
        // やめ、色関連のみに絞ることで回避する。
        className="transition-colors"
      >
        {busy || detailPending ? <Loader2 className="animate-spin" /> : <GitMerge />}
        {merged
          ? "マージ済み"
          : detailPending
            ? DETAIL_PENDING_LABEL
            : judgementPending
              ? MERGE_JUDGEMENT_PENDING_LABEL
              : "マージする"}
      </Button>

      {onDecline && !merged && (
        <Button
          size="sm"
          variant="outline"
          className="text-destructive transition-colors hover:text-destructive"
          onClick={() => setIsDeclineConfirmOpen(true)}
          disabled={declineDisabled}
          title={detailPending ? DETAIL_PENDING_TITLE : undefined}
        >
          {declineBusy ? <Loader2 className="animate-spin" /> : <GitPullRequestClosed />}
          {declined ? "マージしませんでした" : "マージしない"}
        </Button>
      )}

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

      {onDecline && (
        <AlertDialog open={isDeclineConfirmOpen} onOpenChange={setIsDeclineConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>このPRをマージせずに終了しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                {pullRequestNumber != null ? `対応PR #${pullRequestNumber}を` : "対応PRを"}
                クローズします。この操作は次を行い、取り消せません。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>PRをマージせずにクローズする</li>
              <li>このIssueも「対応終了」としてクローズする</li>
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={declineBusy}>キャンセル</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDecline}
                disabled={declineBusy}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                マージしない
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
