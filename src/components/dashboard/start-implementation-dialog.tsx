"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

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
  startImplementationOptionsFromLabels,
  type StartImplementationOptionKey,
} from "@/lib/github/start-implementation";
import type { Issue, IssueComment } from "@/types/issue";

type StartImplementationDialogProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  onCommentCreated: (comment: IssueComment) => void;
  /** トリガーボタンを自前で描画したい場合に指定する（Issue詳細画面での利用を想定） */
  renderTrigger?: (isSubmitting: boolean) => ReactNode;
  /** 呼び出し側で開閉状態を制御したい場合に指定する（Issue作成画面での利用を想定） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * 「実装を開始」ボタン押下時に、計画・開発環境起動・スクリーンショットの要否を
 * 選択させるダイアログ。選択されたオプションに対応するラベルを付与したうえで、
 * 実装エージェントを起動する定型コメントを投稿する。
 *
 * `renderTrigger`を渡すと自前のトリガーボタンから開閉する（Issue詳細画面）。
 * `open`/`onOpenChange`を渡すと呼び出し側が開閉状態を制御できる（Issue作成画面、
 * Issue作成直後に自動で開く用途）。
 */
export function StartImplementationDialog({
  issue,
  onIssueUpdated,
  onCommentCreated,
  renderTrigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: StartImplementationDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const [options, setOptions] = useState(START_IMPLEMENTATION_DEFAULT_OPTIONS);
  const { updateIssue, isSubmitting: isUpdatingIssue } = useIssueMutations();
  const { createComment, isSubmitting: isCreatingComment } = useIssueCommentMutations();
  const isSubmitting = isUpdatingIssue || isCreatingComment;
  // 開いている間にissue（ポーリングによる更新等）が差し替わっても選択中のオプションを
  // 巻き戻さないよう、下のuseEffectの依存配列には含めずrefで最新値だけ参照する。
  const issueLabelsRef = useRef(issue.labels);
  useEffect(() => {
    issueLabelsRef.current = issue.labels;
  });

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびに、issueの最新ラベルを元に選択状態を同期する。openプロパティが
    // 呼び出し側から直接trueにされるケース（Issue作成直後の自動オープン）ではhandleOpenChange
    // を経由しないため、この効果で同期する。open自体の変化にのみ紐づく一度きりの処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    setOptions(startImplementationOptionsFromLabels(issueLabelsRef.current));
  }, [open]);

  function handleOpenChange(nextOpen: boolean) {
    if (onOpenChangeProp) {
      onOpenChangeProp(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  }

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
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {renderTrigger && <DialogTrigger asChild>{renderTrigger(isSubmitting)}</DialogTrigger>}
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
