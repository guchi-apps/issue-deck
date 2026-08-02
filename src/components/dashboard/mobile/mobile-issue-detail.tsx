"use client";

import { useMemo, useState } from "react";

import {
  Archive,
  ArrowLeft,
  CircleAlert,
  FilePlus2,
  FolderGit2,
  Loader2,
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
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { PullRequestLinkBadge } from "@/components/dashboard/pull-request-link-badge";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStatusSteps } from "@/components/dashboard/workflow-status-steps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { APPROVE_COMMENT_BODY, isApprovalPending, labelsAfterApproval } from "@/lib/github/approval-labels";
import { extractLatestPullRequestLink } from "@/lib/github/pull-request-link";
import { canStartImplementation } from "@/lib/github/start-implementation";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import type { Issue } from "@/types/issue";

type MobileIssueDetailProps = {
  issue: Issue;
  issues: Issue[];
  onBack: () => void;
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
};

export function MobileIssueDetail({
  issue,
  issues,
  onBack,
  onEdit,
  onIssueUpdated,
  onToggleFavorite,
  onCreateFollowupIssue,
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
  const [isImageUploading, setIsImageUploading] = useState(false);
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, issue.repositoryFullName),
    [issues, issue.repositoryFullName],
  );
  const pullRequestLink = useMemo(() => {
    const [owner, repo] = issue.repositoryFullName.split("/");
    return extractLatestPullRequestLink(comments, owner, repo);
  }, [comments, issue.repositoryFullName]);
  const swipeBackHandlers = useSwipeBack(onBack);

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

  async function handleClose(stateReason: "completed" | "not_planned") {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "closed",
      stateReason,
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleReopen() {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "open",
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

  async function handleApprove() {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: labelsAfterApproval(issue.labels),
    });
    if (!updated) return;
    onIssueUpdated(updated);

    // ラベル更新はissue-deckのGitHub Appが行うためGitHub上はbotの操作として記録され、
    // issues.unlabeledイベントだけでは実装の再開がトリガーされない（#173）。個人アカウントで
    // 投稿されるコメントを続けて送ることで、issue_commentトリガー経由で確実に再開させる。
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: APPROVE_COMMENT_BODY,
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...updated, commentCount: updated.commentCount + 1 });
    }
  }

  async function handleReject(reason: string) {
    const [owner, repo] = issue.repositoryFullName.split("/");
    const body = reason.trim() ? `@claude ${reason.trim()}` : "@claude 内容を見直してください。";
    const created = await createComment({ owner, repo, number: issue.number, body });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" {...swipeBackHandlers}>
      <header className="flex items-center gap-1 border-b p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="-m-2 rounded-full p-2 active:bg-muted"
        >
          <ArrowLeft className="size-5" />
        </button>
        <span className="flex-1 text-sm font-semibold">Issue詳細</span>
        {canStartImplementation(issue) && (
          <StartImplementationDialog
            issue={issue}
            onIssueUpdated={onIssueUpdated}
            onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
            renderTrigger={(isSubmitting) => (
              <button
                type="button"
                disabled={isSubmitting}
                aria-label="実装を開始"
                className="-m-2 rounded-full p-2 text-primary active:bg-muted disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <Play className="size-5" />
                )}
              </button>
            )}
          />
        )}
        <button
          type="button"
          onClick={() => onToggleFavorite(issue)}
          aria-label={issue.favorite ? "お気に入りから外す" : "お気に入りに追加"}
          className="-m-2 rounded-full p-2 active:bg-muted"
        >
          <Star
            className={
              issue.favorite ? "size-5 fill-yellow-400 text-yellow-400" : "size-5 text-muted-foreground"
            }
          />
        </button>
        <button type="button" aria-label="共有" className="-m-2 rounded-full p-2 active:bg-muted">
          <Share2 className="size-5 text-muted-foreground" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="操作メニュー"
              className="-m-2 rounded-full p-2 active:bg-muted"
            >
              <MoreHorizontal className="size-5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onCreateFollowupIssue(issue)}>
              <FilePlus2 />
              引き継いでIssueを作成
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(issue)}>
              <Pencil />
              編集
            </DropdownMenuItem>
            {issue.state === "open" ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={isSubmitting}>
                  <XCircle />
                  クローズする
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem
                      disabled={isSubmitting}
                      onSelect={() => handleClose("completed")}
                    >
                      完了としてクローズ
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={isSubmitting}
                      onSelect={() => handleClose("not_planned")}
                    >
                      計画外としてクローズ
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem disabled={isSubmitting} onSelect={handleReopen}>
                <RotateCcw />
                再オープンする
              </DropdownMenuItem>
            )}
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

        <h1 className="text-lg font-semibold break-words">
          #{issue.number} {issue.title}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={issue.state === "open" ? "default" : "secondary"}>
            {issue.state === "open" ? "Open" : closedStateLabel(issue.stateReason)}
          </Badge>
          <span>作成日 {new Date(issue.createdAt).toLocaleDateString("ja-JP")}</span>
          <span>{formatRelativeDate(issue.updatedAt)}に更新</span>
        </div>

        <WorkflowStatusSteps labels={issue.labels} />
        <PullRequestLinkBadge link={pullRequestLink} approvalPending={isApprovalPending(issue.labels)} />

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
            {issue.labels.map((label) => {
              const step = matchStatusStep(label.name);
              const attention = isAttentionLabel(label.name);
              return (
                <span
                  key={label.name}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                  style={getLabelBadgeStyle(label.color)}
                  title={step ? `${label.name}（ステップ${step}/${STATUS_STEP_MAX}）` : undefined}
                >
                  {attention && <CircleAlert className="size-3 shrink-0" aria-hidden="true" />}
                  {step && (
                    <span
                      className="h-1.5 w-5 overflow-hidden rounded-full bg-border"
                      aria-hidden="true"
                    >
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(step / STATUS_STEP_MAX) * 100}%`,
                          backgroundColor: label.color,
                        }}
                      />
                    </span>
                  )}
                  {label.name}
                  <button
                    type="button"
                    onClick={() => toggleLabel(label.name)}
                    disabled={isSubmitting}
                    aria-label={`${label.name}を削除`}
                    className="-m-1.5 rounded-full p-1.5 hover:opacity-70 disabled:opacity-50"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <LabelPicker
              labels={repoLabels}
              selectedNames={issue.labels.map((label) => label.name)}
              onToggle={toggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <button
                  type="button"
                  disabled={isSubmitting}
                  aria-label="ラベルを追加"
                  className="flex size-9 items-center justify-center rounded-full border text-muted-foreground disabled:opacity-50"
                >
                  <Plus className="size-4" />
                </button>
              }
            />
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} repositoryFullName={issue.repositoryFullName} />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold">
            コメント <span className="text-muted-foreground">{issue.commentCount}</span>
          </h2>
          <CommentThread
            comments={comments}
            isLoading={isLoading}
            error={error}
            repositoryFullName={issue.repositoryFullName}
            issueSuggestions={issueSuggestions}
            onUpdate={handleUpdateComment}
            onDelete={handleDeleteComment}
            isUpdating={isCommentSubmitting}
            approvalPending={isApprovalPending(issue.labels)}
            onApprove={handleApprove}
            onReject={handleReject}
            isApproving={isSubmitting}
            isRejecting={isCommentSubmitting}
          />

          <div className="mt-4 flex flex-col gap-2">
            <MentionTextarea
              placeholder="コメントを追加..."
              className="min-h-20"
              value={newCommentBody}
              onChange={setNewCommentBody}
              issueSuggestions={issueSuggestions}
              disabled={isCommentSubmitting}
              onUploadingChange={setIsImageUploading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleCreateComment();
                }
              }}
            />
            <Button
              className="self-end"
              onClick={handleCreateComment}
              disabled={!newCommentBody.trim() || isCommentSubmitting || isImageUploading}
            >
              {isCommentSubmitting && <Loader2 className="animate-spin" />}
              {isCommentSubmitting ? "送信中..." : "コメント"}
            </Button>
            {commentMutationError && (
              <p className="text-sm text-destructive">{commentMutationError}</p>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onCreateFollowupIssue(issue)}
        aria-label="引き継いでIssueを作成"
        className="absolute right-4 bottom-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-5" />
      </button>
    </div>
  );
}
