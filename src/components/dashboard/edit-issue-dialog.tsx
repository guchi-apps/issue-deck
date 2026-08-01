"use client";

import { useEffect, useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import type { Issue } from "@/types/issue";

type EditIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: Issue | null;
  onUpdated: (issue: Issue) => void;
};

export function EditIssueDialog({ open, onOpenChange, issue, onUpdated }: EditIssueDialogProps) {
  const { updateIssue, isSubmitting, error, setError } = useIssueMutations();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open || !issue) return;
    // ダイアログを開くたびに対象Issueの最新値でフォームを初期化する。外部トリガー（開閉・対象切替）に
    // 同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(issue.title);
    setBody(issue.body);
    setError(null);
  }, [open, issue, setError]);

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
            <Textarea
              id="edit-issue-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-32"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !title.trim()}>
            {isSubmitting ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
