"use client";

import { useState } from "react";

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

type CancelWorkflowRunButtonProps = {
  run: WorkflowRunInfo | null;
  runId: number | null;
  repositoryFullName: string;
};

/** 実行中のワークフローに対して、確認ダイアログを経てGitHub Actions側にキャンセルをリクエストするボタン */
export function CancelWorkflowRunButton({ run, runId, repositoryFullName }: CancelWorkflowRunButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const { cancelRun, isSubmitting, error } = useWorkflowRunMutations();

  const isRunning = run !== null && run.status !== "completed";
  if (!isRunning || !runId) return null;

  async function handleCancel() {
    if (!runId) return;
    const [owner, repo] = repositoryFullName.split("/");
    const ok = await cancelRun({ owner, repo, runId });
    if (ok) {
      setIsCancelled(true);
      setIsOpen(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        disabled={isSubmitting || isCancelled}
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : <Ban />}
        {isCancelled ? "キャンセル済み" : "キャンセル"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>実行中のワークフローをキャンセルしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              実行中のエージェントの処理を停止します。この操作は取り消せません。
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
