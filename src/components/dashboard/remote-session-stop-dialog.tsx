"use client";

import { AlertTriangle } from "lucide-react";

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
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type { RemoteSessionView } from "@/lib/dispatch/remote-session-rules";

/**
 * リモートセッションの「終了」を押したときの確認ダイアログ（#5346）。
 * 誤タップで落とさないよう、「終了する」を押すまで終了は実行しない。
 * 稼働中（`running`）のセッションは、途中の作業が打ち切られることを知らせる。
 */
export function RemoteSessionStopDialog({
  session,
  onCancel,
  onConfirm,
}: {
  /** 確認の対象。`null`のあいだは閉じている */
  session: RemoteSessionView | null;
  onCancel: () => void;
  /** 「終了する」を押したとき。呼んだあとダイアログは閉じる */
  onConfirm: (id: string) => void;
}) {
  const running = session?.status === "running";
  return (
    <AlertDialog open={session !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {running ? "稼働中のセッションを終了しますか？" : "このセッションを終了しますか？"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {session
              ? `${formatDispatchHostName(session.host)}の「${session.repositoryFullName.split("/")[1]}」（${session.tmuxSessionName}）を終了します。反映まで最大1分ほどかかります。`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {running && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">稼働中のセッションです。終了すると途中の作業は打ち切られます。</span>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <AlertDialogAction onClick={() => session && onConfirm(session.id)}>終了する</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
