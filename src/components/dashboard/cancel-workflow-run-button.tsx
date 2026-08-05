"use client";

import { useEffect, useState } from "react";

import { Ban, Loader2 } from "lucide-react";

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
import { useWorkflowRunMutations } from "@/hooks/use-workflow-run-mutations";
import type { WorkflowRunInfo } from "@/hooks/use-issue-workflow-run";
import { FORCE_CANCEL_AVAILABLE_AFTER_MS } from "@/lib/github/cancel-workflow-run";

type CancelWorkflowRunButtonProps = {
  run: WorkflowRunInfo | null;
  runId: number | null;
  repositoryFullName: string;
};

/** 実行中のワークフローに対して、確認ダイアログを経てGitHub Actions側にキャンセルをリクエストするボタン */
export function CancelWorkflowRunButton({ run, runId, repositoryFullName }: CancelWorkflowRunButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [cancelRequestedAt, setCancelRequestedAt] = useState<number | null>(null);
  const [canForceCancel, setCanForceCancel] = useState(false);
  const { cancelRun, isSubmitting, error } = useWorkflowRunMutations();

  const isRunning = run !== null && run.status !== "completed";

  // 通常キャンセル要求後、閾値時間が経過しても実行中のままなら強制キャンセルの選択肢を出す
  useEffect(() => {
    if (cancelRequestedAt === null || canForceCancel) return;
    const remainingMs = Math.max(0, cancelRequestedAt + FORCE_CANCEL_AVAILABLE_AFTER_MS - Date.now());
    const timeoutId = setTimeout(() => setCanForceCancel(true), remainingMs);
    return () => clearTimeout(timeoutId);
  }, [cancelRequestedAt, canForceCancel]);

  if (!isRunning || !runId) return null;

  const isForceCancel = cancelRequestedAt !== null && canForceCancel;
  const isCancelPending = cancelRequestedAt !== null && !canForceCancel;

  async function handleCancel() {
    if (!runId) return;
    const [owner, repo] = repositoryFullName.split("/");
    const ok = await cancelRun({ owner, repo, runId, force: isForceCancel });
    if (ok) {
      setIsOpen(false);
      if (isForceCancel) {
        setCanForceCancel(false);
      }
      setCancelRequestedAt(Date.now());
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        disabled={isSubmitting || isCancelPending}
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : <Ban />}
        {isCancelPending ? "キャンセル要求中…" : isForceCancel ? "強制キャンセル" : "キャンセル"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isForceCancel
                ? "ワークフローを強制キャンセルしますか？"
                : "実行中のワークフローをキャンセルしますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isForceCancel
                ? "通常のキャンセル要求では停止しなかったため、強制キャンセルを送信します。強制キャンセルでも即座に停止しない場合があります。この操作は取り消せません。"
                : "実行中のエージェントの処理を停止します。この操作は取り消せません。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancel} disabled={isSubmitting}>
              停止する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
