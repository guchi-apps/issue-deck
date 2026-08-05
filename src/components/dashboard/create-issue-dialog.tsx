"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Loader2, Mic } from "lucide-react";

import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
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
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const DEFAULT_ASSIGNEE = "m-guchi";

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
  const hasUserSetAssignee = useRef(false);
  // 作成直後に「実装を開始」オプション選択ダイアログを表示する対象issue。
  // ダイアログ内の非同期処理（ラベル更新→コメント投稿）の途中経過を追うためstateと
  // 併せてrefでも保持し、閉じるタイミングで最新のissueを確実に参照できるようにする。
  const [pendingStartIssue, setPendingStartIssue] = useState<Issue | null>(null);
  const pendingStartIssueRef = useRef<Issue | null>(null);

  function setPendingStart(issue: Issue | null) {
    pendingStartIssueRef.current = issue;
    setPendingStartIssue(issue);
  }

  const { labels, assignees, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );
  const {
    isGenerating: isSuggesting,
    error: suggestError,
    notConfigured: suggestNotConfigured,
    generate: generateSuggestion,
  } = useIssueSuggest();
  const {
    isGenerating: isCleaningUpBody,
    error: bodyCleanupError,
    notConfigured: bodyCleanupNotConfigured,
    generate: generateBodyCleanup,
  } = useIssueBodyCleanup();

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを初期状態へ戻す。外部トリガー（開閉）に同期する一度きりの処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName(defaultRepositoryFullName ?? "");
    setTitle(defaultTitle ?? "");
    setBody(defaultBody ?? "");
    setSelectedLabels([]);
    setAssignee(null);
    setIsImageUploading(false);
    setError(null);
    hasUserSetAssignee.current = false;
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, setError]);

  useEffect(() => {
    if (!open || hasUserSetAssignee.current) return;
    if (assignees.includes(DEFAULT_ASSIGNEE)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAssignee(DEFAULT_ASSIGNEE);
    }
  }, [open, assignees]);

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  function handleAssigneeChange(value: string) {
    hasUserSetAssignee.current = true;
    setAssignee(value === "__none__" ? null : value);
  }

  async function handleGenerateSuggestion() {
    const result = await generateSuggestion(
      body,
      labels.map((label) => ({ name: label.name, description: label.description })),
    );
    if (!result) return;
    setTitle(result.title);
    setSelectedLabels((prev) => [...new Set([...prev, ...result.labels])]);
  }

  async function handleGenerateBodyCleanup() {
    const result = await generateBodyCleanup(body);
    if (!result) return;
    setBody(result.text);
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

  // 「作成+実装開始」ボタン押下時: Issue作成後、Issue詳細画面の「実装を開始」と同じ
  // オプション選択ダイアログを続けて表示する。オプション選択が完了（または取消）して
  // ダイアログが閉じた時点で、その時点の最新issueをonCreatedに渡して一覧・遷移へ反映する。
  async function handleCreateAndStart() {
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body,
      labels: selectedLabels,
      assignee,
    });
    if (issue) {
      onOpenChange(false);
      setPendingStart(issue);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
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
                className="md:text-sm"
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
                repositoryFullName={repositoryFullName}
                placeholder="詳細を入力（任意）"
                className="min-h-32 md:text-sm"
              />
              <div className="flex flex-wrap gap-2">
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
                <div className="flex flex-col gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!body.trim() || !repositoryFullName || isMetaLoading || isSuggesting}
                    onClick={handleGenerateSuggestion}
                  >
                    {isSuggesting ? <Loader2 className="animate-spin" /> : <Bot />}
                    タイトル・ラベルを自動生成
                  </Button>
                  {suggestNotConfigured && (
                    <p className="text-xs text-muted-foreground">
                      Claudeのトークンが設定されていません
                    </p>
                  )}
                  {suggestError && <p className="text-xs text-destructive">{suggestError}</p>}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>ラベル</Label>
              <LabelPicker
                labels={labels}
                selectedNames={selectedLabels}
                onToggle={toggleLabel}
                isLoading={isMetaLoading}
                trigger={
                  <Button variant="outline" className="h-9 w-fit px-3" disabled={isMetaLoading}>
                    {selectedLabels.length > 0 ? `ラベル (${selectedLabels.length})` : "ラベルを選択"}
                    <ChevronDown className="size-3.5" />
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
              <Select value={assignee ?? "__none__"} onValueChange={handleAssigneeChange}>
                <SelectTrigger
                  id="create-issue-assignee"
                  className="h-9 w-full"
                  disabled={isMetaLoading}
                >
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
              variant="secondary"
              onClick={handleCreateAndStart}
              disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
            >
              {isSubmitting ? "作成中..." : "作成+実装開始"}
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
      {pendingStartIssue && (
        <StartImplementationDialog
          issue={pendingStartIssue}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              const finalIssue = pendingStartIssueRef.current;
              setPendingStart(null);
              if (finalIssue) onCreated(finalIssue);
            }
          }}
          onIssueUpdated={setPendingStart}
          onCommentCreated={() => {}}
        />
      )}
    </>
  );
}
