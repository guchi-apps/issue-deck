"use client";

import { useState } from "react";
import { MoreHorizontal, Pencil, XCircle } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { EditPullRequestDialog } from "@/components/dashboard/edit-pull-request-dialog";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import type { PullRequestSummary } from "@/types/pull-request";

type PullRequestActionsMenuProps = {
  pullRequest: PullRequestSummary;
  /** 詳細APIが返した本文。取得前はnullで、その間「編集」は押せない（空の本文で上書きしないため） */
  body: string | null;
  issueSuggestions?: IssueSuggestion[];
  /** 編集を保存できたとき */
  onUpdated: () => void;
  /** クローズできたとき */
  onClosed: () => void;
};

/** 「クローズする」を出すか。Openで未マージのPRだけ（閉じたPRを閉じる操作は無い） */
export function canClosePullRequest(pullRequest: PullRequestSummary): boolean {
  return pullRequest.state === "open" && !pullRequest.merged;
}

/**
 * PR詳細ヘッダーの「…」メニュー（#3161）。Issue詳細の「…」メニューに揃えて「編集」と
 * 「クローズする」を置く。
 *
 * **クローズは確認を挟む。** GitHubから再オープンできる操作ではあるが、Auto-merge待ちのPRを
 * 閉じると自動マージも止まり、気付かないまま取り残される。紐付くIssueもブランチも触らない
 * ——Issueまで閉じたいときは、Issue詳細のマージ承認欄にある「マージしない」（#2780）を使う。
 * クローズのAPIとフックはその「マージしない」と共用している。
 */
export function PullRequestActionsMenu({
  pullRequest,
  body,
  issueSuggestions,
  onUpdated,
  onClosed,
}: PullRequestActionsMenuProps) {
  const { closePullRequest, isSubmitting, error, setError } = usePullRequestMergeMutation();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const closable = canClosePullRequest(pullRequest);

  async function runClose() {
    const [owner, repo] = pullRequest.repositoryFullName.split("/");
    const closed = await closePullRequest({ owner, repo, number: pullRequest.number });
    if (closed) {
      setIsCloseConfirmOpen(false);
      onClosed();
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="PRの操作メニュー">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-0">
          <DropdownMenuItem
            className="whitespace-nowrap text-xs"
            disabled={body === null}
            onSelect={() => setIsEditOpen(true)}
          >
            <Pencil className="size-3.5" />
            編集
          </DropdownMenuItem>
          {closable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="whitespace-nowrap text-xs"
                variant="destructive"
                onSelect={() => {
                  setError(null);
                  setIsCloseConfirmOpen(true);
                }}
              >
                <XCircle className="size-3.5" />
                クローズする
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {body !== null && (
        <EditPullRequestDialog
          open={isEditOpen}
          onOpenChange={setIsEditOpen}
          pullRequest={pullRequest}
          body={body}
          issueSuggestions={issueSuggestions}
          onUpdated={onUpdated}
        />
      )}

      <AlertDialog open={isCloseConfirmOpen} onOpenChange={setIsCloseConfirmOpen}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>このPRをクローズしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pullRequest.repositoryFullName} #{pullRequest.number}（{pullRequest.headRef} →{" "}
              {pullRequest.baseRef}）をマージせずにクローズします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>ブランチは削除しません（GitHubから再オープンできます）</li>
            {pullRequest.linkedIssueNumber !== null && (
              <li>紐付くIssue #{pullRequest.linkedIssueNumber} はクローズしません</li>
            )}
          </ul>
          {pullRequest.autoMergeEnabled && (
            <p className="text-sm text-destructive">
              Auto-mergeが有効です。クローズすると自動マージも止まります。
            </p>
          )}
          <ApiErrorMessage message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                // 結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                event.preventDefault();
                runClose();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "クローズ中..." : "クローズする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
