"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Loader2, Mic } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import {
  clearIssueDraft,
  readRestorableIssueDraft,
  resolveInitialIssueDraft,
  useIssueDraftAutosave,
  type IssueDraft,
} from "@/hooks/use-issue-draft";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  START_IMPLEMENTATION_OPTIONS,
  startImplementationCommentBody,
  startImplementationLabelsForCreate,
} from "@/lib/github/start-implementation";
import { isProgressLabel } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/** 実装オプション用チェックボックスと表示が重複しないよう、ラベル選択欄から除外するラベル名 */
const START_IMPLEMENTATION_OPTION_LABEL_NAMES = new Set(
  START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel),
);

/** 進捗管理用ラベル・実装オプション用ラベルを除いた、ユーザーが選択可能なラベルかどうか */
function isSelectableLabelName(name: string): boolean {
  return !isProgressLabel(name) && !START_IMPLEMENTATION_OPTION_LABEL_NAMES.has(name);
}

/**
 * リポジトリ選択欄で、claude-issue-dispatch.ymlが導入済み（IssueDeckの自動化に対応済み）の
 * リポジトリを先頭に、未導入のリポジトリをその下にまとめる。各グループ内の順序は維持する。
 */
export function groupRepositoriesByWorkflowStatus(
  repositories: ConnectedRepository[],
): { registered: ConnectedRepository[]; unregistered: ConnectedRepository[] } {
  return {
    registered: repositories.filter((repo) => repo.hasClaudeWorkflow),
    unregistered: repositories.filter((repo) => !repo.hasClaudeWorkflow),
  };
}

/**
 * 「タイトル・ラベルを自動生成」実行時の選択ラベルを算出する。
 * 進捗管理用ラベル・実装オプション用ラベル（チェックボックスで個別に選択するもの）はリセット対象外として
 * そのまま維持し、それ以外のユーザー選択可能なラベルは一度リセットしたうえで生成結果を反映する。
 */
export function mergeSuggestedLabels(prev: string[], suggested: string[]): string[] {
  return [
    ...prev.filter((name) => !isSelectableLabelName(name)),
    ...new Set(suggested.filter(isSelectableLabelName)),
  ];
}

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
  const {
    createComment,
    isSubmitting: isCreatingStartComment,
    error: startCommentError,
  } = useIssueCommentMutations();

  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [restorableDraft, setRestorableDraft] = useState<IssueDraft | null>(null);
  const hasUserSetAssignee = useRef(false);

  const { labels, assignees, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );
  const { registered: registeredRepositories, unregistered: unregisteredRepositories } = useMemo(
    () => groupRepositoriesByWorkflowStatus(repositories),
    [repositories],
  );
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
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
    // ダイアログを開くたびにフォームを初期状態へ戻す。明示的なプリフィル（引用元テキスト等）が
    // 渡されていればそちらを優先し、それ以外は空の状態にする（保存済みの下書きは自動では
    // 反映せず、readRestorableIssueDraftの結果をユーザーが「復元する」で選んだ場合のみ反映する）。
    // 外部トリガー（開閉）に同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    const draft = resolveInitialIssueDraft({
      defaultRepositoryFullName,
      defaultTitle,
      defaultBody,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName(draft.repositoryFullName);
    setTitle(draft.title);
    setBody(draft.body);
    setSelectedLabels(draft.selectedLabels);
    setAssignee(draft.assignee);
    setIsImageUploading(false);
    setError(null);
    hasUserSetAssignee.current = draft.assignee !== null;
    setRestorableDraft(
      readRestorableIssueDraft({ defaultRepositoryFullName, defaultTitle, defaultBody }),
    );
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, setError]);

  useIssueDraftAutosave(open, {
    repositoryFullName,
    title,
    body,
    selectedLabels,
    assignee,
  });

  useEffect(() => {
    if (!open || hasUserSetAssignee.current) return;
    if (assignees.includes(DEFAULT_ASSIGNEE)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAssignee(DEFAULT_ASSIGNEE);
    }
  }, [open, assignees]);

  function handleRestoreDraft() {
    if (!restorableDraft) return;
    setRepositoryFullName(defaultRepositoryFullName ?? restorableDraft.repositoryFullName);
    setTitle(restorableDraft.title);
    setBody(restorableDraft.body);
    setSelectedLabels(restorableDraft.selectedLabels);
    setAssignee(restorableDraft.assignee);
    hasUserSetAssignee.current = restorableDraft.assignee !== null;
    setRestorableDraft(null);
  }

  function resetForm() {
    setRepositoryFullName("");
    setTitle("");
    setBody("");
    setSelectedLabels([]);
    setAssignee(null);
    hasUserSetAssignee.current = false;
  }

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
    setSelectedLabels((prev) => mergeSuggestedLabels(prev, result.labels));
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
      resetForm();
      clearIssueDraft();
      onCreated(issue);
      onOpenChange(false);
    }
  }

  // 「作成+実装開始」ボタン押下時: 実装オプションの選択はこの画面のチェックボックスで
  // 既に完了しているため、Issue詳細画面の「実装を開始」ダイアログと同じオプション選択画面を
  // 再度挟まず、選択済みラベルに進捗状況ラベルを加えてIssueを作成し、続けて実装開始の
  // 定型コメントを投稿する（#774）。
  async function handleCreateAndStart() {
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body,
      labels: startImplementationLabelsForCreate(selectedLabels),
      assignee,
    });
    if (!issue) return;

    const [owner, repo] = repositoryFullName.split("/");
    const comment = await createComment({
      owner,
      repo,
      number: issue.number,
      body: startImplementationCommentBody(selectedLabels.includes(PLAN_REQUIRED_LABEL)),
    });

    resetForm();
    clearIssueDraft();
    onOpenChange(false);
    onCreated(comment ? { ...issue, commentCount: issue.commentCount + 1 } : issue);
  }

  return (
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

        {restorableDraft && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            <span>保存された下書きがあります</span>
            <Button variant="outline" size="xs" onClick={handleRestoreDraft}>
              復元する
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-issue-repo">リポジトリ</Label>
            <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
              <SelectTrigger id="create-issue-repo" className="w-full">
                <SelectValue placeholder="リポジトリを選択" />
              </SelectTrigger>
              <SelectContent>
                {registeredRepositories.length > 0 && (
                  <SelectGroup>
                    {unregisteredRepositories.length > 0 && <SelectLabel>登録済み</SelectLabel>}
                    {registeredRepositories.map((repo) => (
                      <SelectItem key={repo.id} value={repo.fullName}>
                        {repo.fullName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {unregisteredRepositories.length > 0 && (
                  <SelectGroup>
                    {registeredRepositories.length > 0 && <SelectLabel>未登録</SelectLabel>}
                    {unregisteredRepositories.map((repo) => (
                      <SelectItem key={repo.id} value={repo.fullName}>
                        {repo.fullName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
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
              labels={selectableLabels}
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
            {selectedLabels.filter(isSelectableLabelName).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedLabels.filter(isSelectableLabelName).map((name) => {
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

          <div className="flex flex-col gap-3">
            {START_IMPLEMENTATION_OPTIONS.map((option) => (
              <div key={option.key} className="flex items-start gap-2">
                <Checkbox
                  id={`create-issue-option-${option.key}`}
                  checked={selectedLabels.includes(option.githubLabel)}
                  onCheckedChange={() => toggleLabel(option.githubLabel)}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`create-issue-option-${option.key}`}
                  className="flex-col items-start gap-0.5"
                >
                  {option.label}
                  <span className="text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                </Label>
              </div>
            ))}
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

          <ApiErrorMessage message={error ?? startCommentError} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            variant="secondary"
            onClick={handleCreateAndStart}
            disabled={
              isSubmitting ||
              isCreatingStartComment ||
              !repositoryFullName ||
              !title.trim() ||
              isImageUploading
            }
          >
            {isSubmitting || isCreatingStartComment ? "作成中..." : "作成+実装開始"}
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
