"use client";

import { useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
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
import { mergeWarnings } from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type { OpenPullRequest } from "@/types/pull-request";

type PullRequestMergeButtonProps = {
  pullRequest: OpenPullRequest;
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
 */
export function PullRequestMergeButton({
  pullRequest,
  onMerged,
  className,
  variant = "outline",
}: PullRequestMergeButtonProps) {
  const { mergePullRequest, isSubmitting, error } = usePullRequestMergeMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const warnings = mergeWarnings(pullRequest);
  const [owner, repo] = pullRequest.repositoryFullName.split("/");

  async function runMerge() {
    const merged = await mergePullRequest({ owner, repo, number: pullRequest.number });
    setConfirmOpen(false);
    if (merged) onMerged();
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {error && <span className="truncate text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant={variant}
        className="h-7 shrink-0"
        disabled={isSubmitting}
        onClick={() => (warnings.length > 0 ? setConfirmOpen(true) : runMerge())}
      >
        {isSubmitting ? "マージ中..." : "マージする"}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このPRをマージしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pullRequest.repositoryFullName} #{pullRequest.number}（{pullRequest.headRef} →{" "}
              {pullRequest.baseRef}）をマージします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
