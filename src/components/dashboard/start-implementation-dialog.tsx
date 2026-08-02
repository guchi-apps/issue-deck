"use client";

import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import {
  START_IMPLEMENTATION_COMMENT_BODY,
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  START_IMPLEMENTATION_OPTIONS,
  startImplementationLabelsToAdd,
  type StartImplementationOptionKey,
} from "@/lib/github/start-implementation";
import type { Issue, IssueComment } from "@/types/issue";

type StartImplementationDialogProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  onCommentCreated: (comment: IssueComment) => void;
  renderTrigger: (isSubmitting: boolean) => ReactNode;
};

/**
 * 「実装を開始」ボタン押下時に、計画・開発環境起動・スクリーンショットの要否を
 * 選択させるダイアログ。選択されたオプションに対応するラベルを付与したうえで、
 * 実装エージェントを起動する定型コメントを投稿する。
 */
export function StartImplementationDialog({
  issue,
  onIssueUpdated,
  onCommentCreated,
  renderTrigger,
}: StartImplementationDialogProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(START_IMPLEMENTATION_DEFAULT_OPTIONS);
  const { updateIssue, isSubmitting: isUpdatingIssue } = useIssueMutations();
  const { createComment, isSubmitting: isCreatingComment } = useIssueCommentMutations();
  const isSubmitting = isUpdatingIssue || isCreatingComment;

  function toggleOption(key: StartImplementationOptionKey) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleStart() {
    let currentIssue = issue;

    const labelsToAdd = startImplementationLabelsToAdd(options);
    if (labelsToAdd.length > 0) {
      const currentNames = issue.labels.map((label) => label.name);
      const nextNames = [...new Set([...currentNames, ...labelsToAdd])];
      const updated = await updateIssue({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        labels: nextNames,
      });
      if (!updated) return;
      currentIssue = updated;
      onIssueUpdated(updated);
    }

    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: START_IMPLEMENTATION_COMMENT_BODY,
    });
    if (!created) return;

    onCommentCreated(created);
    onIssueUpdated({ ...currentIssue, commentCount: currentIssue.commentCount + 1 });
    setOptions(START_IMPLEMENTATION_DEFAULT_OPTIONS);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{renderTrigger(isSubmitting)}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>実装を開始</DialogTitle>
          <DialogDescription>必要なオプションを選択してから実装を開始してください。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {START_IMPLEMENTATION_OPTIONS.map((option) => (
            <div key={option.key} className="flex items-start gap-2">
              <Checkbox
                id={`start-implementation-${option.key}`}
                checked={options[option.key]}
                onCheckedChange={() => toggleOption(option.key)}
                className="mt-0.5"
              />
              <Label htmlFor={`start-implementation-${option.key}`} className="flex-col items-start gap-0.5">
                {option.label}
                <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
              </Label>
            </div>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              キャンセル
            </Button>
          </DialogClose>
          <Button onClick={handleStart} disabled={isSubmitting}>
            開始する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
