"use client";

import { AlertTriangle, GitCommitHorizontal } from "lucide-react";

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
import { SESSION_CONTROL_LABELS } from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { describeSessionStep, isSessionBusy } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * 「セッション終了」の確認ダイアログ（#4881）。Issue詳細のセッション詳細・セッションの
 * カード・実行状況のセッション行の3か所から同じものを開く。
 *
 * **閉じる前に知らせるのは2つだけ。** 作業中（busy）なら途中の作業を打ち切ること、worktreeに
 * 未コミットの変更があればその件数。どちらも終了を止めはしない（決めるのは押した人）。
 * 未コミットの件数はpollerが毎巡運んでくる値で、分からない（`null`・古いpoller）ときは出さない。
 */
export function SessionCloseDialog({
  session,
  open,
  onOpenChange,
  submitting,
  onConfirm,
}: {
  session: DispatchSessionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 送信中。両方のボタンを押せなくする */
  submitting: boolean;
  /** 閉じる操作を積む。終わるまでダイアログは開いたままにする */
  onConfirm: () => Promise<unknown>;
}) {
  const busy = isSessionBusy(session);
  const step = busy ? describeSessionStep(session) : null;
  const changes = session.worktreeChangeCount ?? null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {busy ? "作業中のセッションを終了しますか？" : "このセッションを終了しますか？"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {formatDispatchHostName(session.host)}の「{session.tmuxSessionName}」を終了します。worktreeは
            そのまま残り、次にこのIssueで起動したときは前回の会話の続きから再開します。反映まで最大1分ほど
            かかります。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {busy && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="block font-medium">
                いま作業中です
                {step && `（${step.label}${step.since ? `・${step.since}前から` : ""}）`}
              </span>
              終了すると途中の作業は打ち切られます。止めるだけなら「作業を止める」を使ってください。
            </span>
          </div>
        )}
        {changes !== null && changes > 0 && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          >
            <GitCommitHorizontal aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="block font-medium">
                worktreeに未コミットの変更が{changes}件あります
              </span>
              終了しても変更はworktreeに残りますが、コミット・pushはされません。
            </span>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              // 送信の結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
              event.preventDefault();
              void onConfirm().finally(() => onOpenChange(false));
            }}
          >
            {busy ? "作業中でも終了する" : SESSION_CONTROL_LABELS.KILL.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
