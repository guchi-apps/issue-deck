"use client";

import { useState } from "react";

import { GitMerge, Loader2 } from "lucide-react";

import { PullRequestCiStatusBadge } from "@/components/dashboard/pull-request-ci-status";
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
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
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
  isMerging?: boolean;
  isMerged?: boolean;
  /** マージ失敗時のエラーメッセージ。ボタンの手前にインライン表示する */
  error?: string | null;
  /** trueならボタンの手前にCI状態バッジを並べる */
  showCiStatus?: boolean;
  /** スマホのヘッダーに置くときはアイコンだけの丸ボタンにする */
  appearance?: "button" | "icon";
  className?: string;
};

/**
 * Issue画面から対応PRをマージするボタン（#1288）。
 *
 * コメント欄のマージ待ちカードと画面上部の操作列の両方から同じ操作を出すため、ボタンと確認
 * ダイアログをこのコンポーネントに切り出している。マージ済みかどうかは呼び出し側が持ち、
 * どちらから押しても両方が「マージ済み」になるようにする。
 *
 * PR一覧・PR詳細画面のマージボタンは`PullRequestMergeButton`（`pull-request-merge-button.tsx`）で、
 * `PullRequestSummary`を前提に警告付きの確認を出す別物。Issue画面はPR番号しか持たないためこちらを使う。
 */
export function IssueMergeButton({
  onMerge,
  onMerged,
  pullRequestNumber,
  ciStatus,
  isMerging,
  isMerged,
  error,
  showCiStatus = false,
  appearance = "button",
  className,
}: IssueMergeButtonProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const busy = Boolean(isMerging);
  const merged = Boolean(isMerged);
  const disabled = busy || merged || ciStatus === "in_progress";

  async function confirmMerge() {
    const ok = await onMerge();
    setIsConfirmOpen(false);
    if (ok) onMerged?.();
  }

  const label = merged
    ? "マージ済み"
    : ciStatus === "in_progress"
      ? "CI実行中のためマージできません"
      : "マージする";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {error && <span className="truncate text-xs text-destructive">{error}</span>}
      {showCiStatus && <PullRequestCiStatusBadge status={ciStatus ?? null} />}
      {appearance === "icon" ? (
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={() => setIsConfirmOpen(true)}
          className="-m-3 rounded-full p-3 text-primary active:bg-muted disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <GitMerge className="size-5" />
          )}
        </button>
      ) : (
        <Button
          size="sm"
          onClick={() => setIsConfirmOpen(true)}
          disabled={disabled}
          // CIバッジの出現とdisabled化が同一レンダーで重なると、バッジ挿入によるレイアウトの
          // 横移動とopacityのtransition-all（既定）が競合し、モバイルSafariで旧位置の
          // ボタンが一瞬二重表示される（#1115）。opacityを含む全プロパティのtransitionを
          // やめ、色関連のみに絞ることで回避する。
          className="transition-colors"
        >
          {busy ? <Loader2 className="animate-spin" /> : <GitMerge />}
          {merged ? "マージ済み" : "マージする"}
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
    </div>
  );
}
