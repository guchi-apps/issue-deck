"use client";

import { useEffect, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { MentionTextarea, type IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePullRequestUpdateMutation } from "@/hooks/use-pull-request-update-mutation";
import type { PullRequestSummary } from "@/types/pull-request";

type EditPullRequestDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pullRequest: PullRequestSummary;
  /** 編集前の本文。詳細APIが返したもの */
  body: string;
  issueSuggestions?: IssueSuggestion[];
  /** 保存できたとき */
  onUpdated: () => void;
};

/**
 * PRのタイトル・本文を編集するダイアログ（#3161）。形はIssueの編集（`EditIssueDialog`）に揃える。
 *
 * Issue編集にある「付け直す」（AIのタイトル生成）と本文整形は持たない。どちらもIssueの
 * 起票を前提にした文面を返すため、PRの本文（テンプレートの見出しが決まっている）には合わない。
 */
export function EditPullRequestDialog({
  open,
  onOpenChange,
  pullRequest,
  body: initialBody,
  issueSuggestions = [],
  onUpdated,
}: EditPullRequestDialogProps) {
  const { updatePullRequest, isSubmitting, error, setError } = usePullRequestUpdateMutation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isImageUploading, setIsImageUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 開くたびに最新のタイトル・本文でフォームを初期化する（EditIssueDialogと同じ一度きりの同期）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(pullRequest.title);
    setBody(initialBody);
    setIsImageUploading(false);
    setError(null);
  }, [open, pullRequest.title, initialBody, setError]);

  async function handleSubmit() {
    if (!title.trim() || isSubmitting || isImageUploading) return;
    const [owner, repo] = pullRequest.repositoryFullName.split("/");
    const updated = await updatePullRequest({ owner, repo, number: pullRequest.number, title, body });
    if (updated) {
      onUpdated();
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>#{pullRequest.number} を編集</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-pull-request-title">タイトル</Label>
            <Input
              id="edit-pull-request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-pull-request-body">本文</Label>
            <MentionTextarea
              id="edit-pull-request-body"
              value={body}
              onChange={setBody}
              issueSuggestions={issueSuggestions}
              onUploadingChange={setIsImageUploading}
              repositoryFullName={pullRequest.repositoryFullName}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="min-h-32"
            />
          </div>

          <ApiErrorMessage message={error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !title.trim() || isImageUploading}>
            {isSubmitting ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
