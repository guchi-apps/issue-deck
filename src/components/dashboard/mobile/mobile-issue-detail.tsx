"use client";

import { useState } from "react";

import {
  Archive,
  ArrowLeft,
  FolderGit2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Share2,
  Star,
  XCircle,
} from "lucide-react";

import { CommentThread } from "@/components/dashboard/comment-thread";
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
import { Textarea } from "@/components/ui/textarea";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { cn } from "@/lib/utils";
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
  const { createComment, updateComment, deleteComment } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");

  async function handleToggleState() {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: issue.state === "open" ? "closed" : "open",
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleCreateComment() {
    if (!newCommentBody.trim()) return;
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: newCommentBody,
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      setNewCommentBody("");
      onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    }
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
        <button
          type="button"
          onClick={() => onToggleFavorite(issue)}
          aria-label={issue.favorite ? "お気に入りから外す" : "お気に入りに追加"}
        >
          <Star
            className={cn(
              "size-4 text-muted-foreground",
              issue.favorite && "fill-yellow-400 text-yellow-400",
            )}
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
            {issue.assignee ? (
              <span className="flex items-center gap-1.5 text-sm">
                <UserAvatar login={issue.assignee.login} />
                {issue.assignee.login}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">未設定</span>
            )}
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">ラベル</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label.name}
                className="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                style={getLabelBadgeStyle(label.color)}
              >
                {label.name}
              </span>
            ))}
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-full border text-muted-foreground"
            >
              <Plus className="size-3.5" />
            </button>
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
