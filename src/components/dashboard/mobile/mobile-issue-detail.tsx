"use client";

import { useState } from "react";

import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  FolderGit2,
  Lock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Star,
  X,
  XCircle,
} from "lucide-react";

import { CommentThread } from "@/components/dashboard/comment-thread";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { getIssueDispatchCta } from "@/lib/issue-dispatch-cta";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import type { Issue } from "@/types/issue";

type MobileIssueDetailProps = {
  issue: Issue;
  onBack: () => void;
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
};

export function MobileIssueDetail({
  issue,
  onBack,
  onEdit,
  onIssueUpdated,
  onToggleFavorite,
}: MobileIssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const { updateIssue, isSubmitting } = useIssueMutations();
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const cta = getIssueDispatchCta(issue);

  async function toggleLabel(name: string) {
    const current = issue.labels.map((label) => label.name);
    const next = current.includes(name)
      ? current.filter((label) => label !== name)
      : [...current, name];
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: next,
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleAssigneeChange(login: string | null) {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      assignee: login,
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleToggleState() {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: issue.state === "open" ? "closed" : "open",
    });
    if (updated) onIssueUpdated(updated);
  }

  async function postComment(body: string): Promise<boolean> {
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({ owner, repo, number: issue.number, body });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
      return true;
    }
    return false;
  }

  async function handleCreateComment() {
    if (!newCommentBody.trim()) return;
    if (await postComment(newCommentBody)) setNewCommentBody("");
  }

  async function handleUpdateComment(commentId: string, body: string): Promise<boolean> {
    const [owner, repo] = issue.repositoryFullName.split("/");
    const updated = await updateComment({ owner, repo, commentId: Number(commentId), body });
    if (updated) {
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
      return true;
    }
    return false;
  }

  async function handleDeleteComment(commentId: string): Promise<boolean> {
    const [owner, repo] = issue.repositoryFullName.split("/");
    const ok = await deleteComment({ owner, repo, commentId: Number(commentId) });
    if (ok) {
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      onIssueUpdated({ ...issue, commentCount: Math.max(0, issue.commentCount - 1) });
    }
    return ok;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b p-4">
        <button type="button" onClick={onBack}>
          <ArrowLeft className="size-5" />
        </button>
        <span className="flex-1 text-sm font-semibold">Issue詳細</span>
        {cta.mode && (
          <button
            type="button"
            onClick={() => postComment(cta.commentBody)}
            disabled={isCommentSubmitting}
            aria-label={cta.mode === "start" ? "実装を開始" : "計画を承認して実装を再開"}
            className="text-muted-foreground disabled:opacity-50"
          >
            {cta.mode === "start" ? (
              <Play className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggleFavorite(issue)}
          aria-label={issue.favorite ? "お気に入りから外す" : "お気に入りに追加"}
        >
          <Star
            className={
              issue.favorite ? "size-4 fill-yellow-400 text-yellow-400" : "size-4 text-muted-foreground"
            }
          />
        </button>
        <Share2 className="size-4 text-muted-foreground" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="操作メニュー">
              <MoreHorizontal className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEdit(issue)}>
              <Pencil />
              編集
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isSubmitting} onSelect={handleToggleState}>
              {issue.state === "open" ? (
                <>
                  <XCircle />
                  クローズする
                </>
              ) : (
                <>
                  <RotateCcw />
                  再オープンする
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex flex-col gap-4 overflow-y-auto p-4 pb-20">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2 className="size-3.5" />
          {issue.repositoryFullName}
          {issue.repositoryArchived && (
            <Archive className="size-3" aria-label="アーカイブ済み" />
          )}
          {issue.repositoryPrivate && <Lock className="size-3" aria-label="プライベート" />}
        </span>

        <h1 className="text-lg font-semibold">
          #{issue.number} {issue.title}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={issue.state === "open" ? "default" : "secondary"}>
            {issue.state === "open" ? "Open" : "Closed"}
          </Badge>
          <span>作成日 {new Date(issue.createdAt).toLocaleDateString("ja-JP")}</span>
          <span>{formatRelativeDate(issue.updatedAt)}に更新</span>
        </div>

        <div className="flex items-center gap-6">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">作成者</p>
            <span className="flex items-center gap-1.5 text-sm">
              <UserAvatar login={issue.author.login} />
              {issue.author.login}
            </span>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">担当者</p>
            <Select
              value={issue.assignee?.login ?? "__none__"}
              onValueChange={(value) => handleAssigneeChange(value === "__none__" ? null : value)}
            >
              <SelectTrigger className="h-auto border-none p-0 text-sm shadow-none" disabled={isMetaLoading || isSubmitting}>
                <SelectValue placeholder="担当者を選択" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未設定</SelectItem>
                {repoAssignees.map((login) => (
                  <SelectItem key={login} value={login}>
                    {login}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">ラベル</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label.name}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                style={getLabelBadgeStyle(label.color)}
              >
                {label.name}
                <button
                  type="button"
                  onClick={() => toggleLabel(label.name)}
                  disabled={isSubmitting}
                  aria-label={`${label.name}を削除`}
                  className="rounded-full hover:opacity-70 disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <LabelPicker
              labels={repoLabels}
              selectedNames={issue.labels.map((label) => label.name)}
              onToggle={toggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <button
                  type="button"
                  disabled={isSubmitting}
                  className="flex size-6 items-center justify-center rounded-full border text-muted-foreground disabled:opacity-50"
                >
                  <Plus className="size-3.5" />
                </button>
              }
            />
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold">
            コメント <span className="text-muted-foreground">{issue.commentCount}</span>
          </h2>
          <CommentThread
            comments={comments}
            isLoading={isLoading}
            error={error}
            onUpdate={handleUpdateComment}
            onDelete={handleDeleteComment}
          />

          <div className="mt-4 flex flex-col gap-2">
            <Textarea
              placeholder="コメントを追加..."
              className="min-h-20"
              value={newCommentBody}
              onChange={(e) => setNewCommentBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleCreateComment();
                }
              }}
            />
            <Button className="self-end" onClick={handleCreateComment} disabled={!newCommentBody.trim()}>
              コメント
            </Button>
            {commentMutationError && (
              <p className="text-sm text-destructive">{commentMutationError}</p>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="absolute right-4 bottom-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-5" />
      </button>
    </div>
  );
}
