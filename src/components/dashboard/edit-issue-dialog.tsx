"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Mic } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
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
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import type { Issue } from "@/types/issue";

type EditIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: Issue | null;
  issues: Issue[];
  onUpdated: (issue: Issue) => void;
};

export function EditIssueDialog({ open, onOpenChange, issue, issues, onUpdated }: EditIssueDialogProps) {
  const { updateIssue, isSubmitting, error, setError } = useIssueMutations();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isImageUploading, setIsImageUploading] = useState(false);
  const issueSuggestions = useMemo(
    () => (issue ? getRepoIssueSuggestions(issues, issue.repositoryFullName) : []),
    [issues, issue],
  );
  const {
    isGenerating: isCleaningUpBody,
    error: bodyCleanupError,
    notConfigured: bodyCleanupNotConfigured,
    generate: generateBodyCleanup,
  } = useIssueBodyCleanup();

  useEffect(() => {
    if (!open || !issue) return;
    // ダイアログを開くたびに対象Issueの最新値でフォームを初期化する。外部トリガー（開閉・対象切替）に
    // 同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(issue.title);
    setBody(issue.body);
    setIsImageUploading(false);
    setError(null);
  }, [open, issue, setError]);

  async function handleGenerateBodyCleanup() {
    const result = await generateBodyCleanup(body);
    if (!result) return;
    setBody(result.text);
  }

  async function handleSubmit() {
    if (!issue || !title.trim()) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      title,
      body,
    });
    if (updated) {
      onUpdated(updated);
      onOpenChange(false);
    }
  }

  if (!issue) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            #{issue.number} を編集
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-issue-title">タイトル</Label>
            <Input
              id="edit-issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-issue-body">本文</Label>
            <MentionTextarea
              id="edit-issue-body"
              value={body}
              onChange={setBody}
              issueSuggestions={issueSuggestions}
              onUploadingChange={setIsImageUploading}
              repositoryFullName={issue.repositoryFullName}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="min-h-32"
            />
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="xs"
                disabled={!body.trim() || isCleaningUpBody}
                onClick={handleGenerateBodyCleanup}
              >
                {isCleaningUpBody ? <Loader2 className="animate-spin" /> : <Mic />}
                音声入力を整理
              </Button>
              {bodyCleanupNotConfigured && (
                <p className="text-xs text-muted-foreground">
                  Claudeのトークンが設定されていません
                </p>
              )}
              {bodyCleanupError && <p className="text-xs text-destructive">{bodyCleanupError}</p>}
            </div>
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
