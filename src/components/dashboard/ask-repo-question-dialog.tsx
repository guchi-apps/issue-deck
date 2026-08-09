"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { ASK_REPO_QUESTION_TITLE_PREFIX, askClaudeCommentBody } from "@/lib/github/ask-claude";
import { isSelectableLabelName } from "@/lib/github/start-implementation";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const ASK_REPO_QUESTION_TITLE_MAX_LENGTH = 40;

/**
 * 質問文からIssueタイトルを機械的に生成する（Claudeによる自動生成は行わない）。
 * 改行・連続空白は1つの半角スペースにまとめ、長い質問は末尾を省略記号で丸める。
 */
export function buildAskRepoQuestionTitle(question: string): string {
  const normalized = question.trim().replace(/\s+/g, " ");
  const truncated =
    normalized.length > ASK_REPO_QUESTION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, ASK_REPO_QUESTION_TITLE_MAX_LENGTH)}…`
      : normalized;
  return `${ASK_REPO_QUESTION_TITLE_PREFIX}${truncated}`;
}

type AskRepoQuestionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  onCreated: (issue: Issue) => void;
};

/**
 * Issueを立てずに質問だけで完結させたい要望（#691）への対応。内部的にはIssueを1件
 * 自動作成し、続けて既存の「Claudeに質問する」定型コメント（mode=ask）を投稿する。
 * mode=askの自動応答を前提とするため、claude-issue-dispatch.yml未導入のリポジトリは
 * 選択肢に出さない。
 */
export function AskRepoQuestionDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  onCreated,
}: AskRepoQuestionDialogProps) {
  const { createIssue, isSubmitting: isCreatingIssue, error: createError, setError: setCreateError } =
    useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();

  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [question, setQuestion] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);

  const askableRepositories = useMemo(
    () => repositories.filter((repo) => repo.hasClaudeWorkflow),
    [repositories],
  );
  const { labels, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
  );

  useEffect(() => {
    if (!open) return;
    const initialRepo =
      defaultRepositoryFullName &&
      askableRepositories.some((repo) => repo.fullName === defaultRepositoryFullName)
        ? defaultRepositoryFullName
        : (askableRepositories[0]?.fullName ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName(initialRepo);
    setQuestion("");
    setSelectedLabels([]);
    setCreateError(null);
    setCommentError(null);
    // askableRepositoriesはrepositoriesから毎レンダー再計算されるため依存に含めない
    // （含めると開いている間に無関係な再選択が発生し得る）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultRepositoryFullName, setCreateError, setCommentError]);

  const isSubmitting = isCreatingIssue || isCreatingComment;

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  async function handleSubmit() {
    if (!repositoryFullName || !question.trim()) return;

    const issue = await createIssue({
      repositoryFullName,
      title: buildAskRepoQuestionTitle(question),
      body: question,
      labels: selectedLabels,
      assignee: null,
    });
    if (!issue) return;

    const [owner, repo] = repositoryFullName.split("/");
    const comment = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(question),
    });

    setQuestion("");
    setSelectedLabels([]);
    onOpenChange(false);
    onCreated(comment ? { ...issue, commentCount: issue.commentCount + 1 } : issue);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>リポジトリに質問する</DialogTitle>
          <DialogDescription>
            質問内容でIssueを自動作成し、Claudeに質問します。回答はコメントとして返るまで数十秒〜数分かかります。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ask-repo-question-repo">リポジトリ</Label>
            {askableRepositories.length > 0 ? (
              <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                <SelectTrigger id="ask-repo-question-repo" className="w-full">
                  <SelectValue placeholder="リポジトリを選択" />
                </SelectTrigger>
                <SelectContent>
                  {askableRepositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                claude-issue-dispatch.ymlが導入されているリポジトリがありません。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ask-repo-question-body">質問内容</Label>
            <Textarea
              id="ask-repo-question-body"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="質問内容を入力してください"
              className="min-h-32 md:text-sm"
              autoFocus
            />
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

          <ApiErrorMessage message={createError ?? commentError} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !repositoryFullName || !question.trim()}
          >
            {isSubmitting ? "送信中..." : "質問する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
