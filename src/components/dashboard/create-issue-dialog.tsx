"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { LabelPicker } from "@/components/dashboard/label-picker";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type CreateIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  defaultTitle?: string | null;
  defaultBody?: string | null;
  issues: Issue[];
  onCreated: (issue: Issue) => void;
};

export function CreateIssueDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  defaultTitle,
  defaultBody,
  issues,
  onCreated,
}: CreateIssueDialogProps) {
  const { createIssue, isSubmitting, error, setError } = useIssueMutations();

  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);

  const { labels, assignees, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを初期状態へ戻す。外部トリガー（開閉）に同期する一度きりの処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName(defaultRepositoryFullName ?? repositories[0]?.fullName ?? "");
    setTitle(defaultTitle ?? "");
    setBody(defaultBody ?? "");
    setSelectedLabels([]);
    setAssignee(null);
    setIsImageUploading(false);
    setError(null);
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, repositories, setError]);

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  async function handleSubmit() {
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body,
      labels: selectedLabels,
      assignee,
    });
    if (issue) {
      onCreated(issue);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新しいIssueを作成</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-issue-repo">リポジトリ</Label>
            <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
              <SelectTrigger id="create-issue-repo" className="w-full">
                <SelectValue placeholder="リポジトリを選択" />
              </SelectTrigger>
              <SelectContent>
                {repositories.map((repo) => (
                  <SelectItem key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-issue-title">タイトル</Label>
            <Input
              id="create-issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Issueのタイトル"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-issue-body">本文</Label>
            <MentionTextarea
              id="create-issue-body"
              value={body}
              onChange={setBody}
              issueSuggestions={issueSuggestions}
              onUploadingChange={setIsImageUploading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="詳細を入力（任意）"
              className="min-h-32"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>ラベル</Label>
            <LabelPicker
              labels={labels}
              selectedNames={selectedLabels}
              onToggle={toggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <Button variant="outline" size="sm" className="w-fit text-xs" disabled={isMetaLoading}>
                  {selectedLabels.length > 0 ? `ラベル (${selectedLabels.length})` : "ラベルを選択"}
                  <ChevronDown className="size-3" />
                </Button>
              }
            />
            {selectedLabels.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedLabels.map((name) => {
                  const label = labels.find((l) => l.name === name);
                  return (
                    <span
                      key={name}
                      className="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                      style={getLabelBadgeStyle(label?.color ?? "#64748b")}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-issue-assignee">担当者</Label>
            <Select
              value={assignee ?? "__none__"}
              onValueChange={(value) => setAssignee(value === "__none__" ? null : value)}
            >
              <SelectTrigger id="create-issue-assignee" className="w-full" disabled={isMetaLoading}>
                <SelectValue placeholder="担当者を選択" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未設定</SelectItem>
                {assignees.map((login) => (
                  <SelectItem key={login} value={login}>
                    {login}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
          >
            {isSubmitting ? "作成中..." : "作成"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
