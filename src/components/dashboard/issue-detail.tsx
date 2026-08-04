"use client";

import { useMemo, useState } from "react";

import {
  Archive,
  Bot,
  ExternalLink,
  FilePlus2,
  Loader2,
  Lock,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Star,
  XCircle,
} from "lucide-react";

import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { PullRequestLinkBadge } from "@/components/dashboard/pull-request-link-badge";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowRunStatus } from "@/components/dashboard/workflow-run-status";
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
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueWorkflowRun } from "@/hooks/use-issue-workflow-run";
import { usePullRequestCiStatus } from "@/hooks/use-pull-request-ci-status";
import {
  approveCommentBody,
  isApprovalPending,
  isMergeApprovalPending,
  labelsAfterApproval,
  labelsAfterRejection,
  requestContinuationCommentBody,
} from "@/lib/github/approval-labels";
import { canAskClaude } from "@/lib/github/ask-claude";
import { buildClaudeAppUrl } from "@/lib/github/claude-app";
import { extractLatestPullRequestLink } from "@/lib/github/pull-request-link";
import { canStartImplementation } from "@/lib/github/start-implementation";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type IssueDetailProps = {
  issue: Issue | null;
  issues: Issue[];
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
};

export function IssueDetail({
  issue,
  issues,
  onEdit,
  onIssueUpdated,
  onToggleFavorite,
  onCreateFollowupIssue,
}: IssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const { run: workflowRun, runId: workflowRunId } = useIssueWorkflowRun(issue, comments);
  const { updateIssue, isSubmitting } = useIssueMutations();
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const issueSuggestions = useMemo(
    () => (issue ? getRepoIssueSuggestions(issues, issue.repositoryFullName) : []),
    [issues, issue],
  );
  const pullRequestLink = useMemo(() => {
    if (!issue) return null;
    const [owner, repo] = issue.repositoryFullName.split("/");
    return extractLatestPullRequestLink(comments, owner, repo);
  }, [comments, issue]);
  const { status: pullRequestCiStatus } = usePullRequestCiStatus(
    issue?.repositoryFullName ?? null,
    pullRequestLink,
    issue ? isMergeApprovalPending(issue.labels) : false,
  );

  async function handleClose(stateReason: "completed" | "not_planned") {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "closed",
      stateReason,
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleReopen() {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "open",
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleCreateComment() {
    if (!issue || !newCommentBody.trim()) return;
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
    if (!issue) return false;
    const [owner, repo] = issue.repositoryFullName.split("/");
    const updated = await updateComment({ owner, repo, commentId: Number(commentId), body });
    if (updated) {
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
      return true;
    }
    return false;
  }

  async function handleDeleteComment(commentId: string): Promise<boolean> {
    if (!issue) return false;
    const [owner, repo] = issue.repositoryFullName.split("/");
    const ok = await deleteComment({ owner, repo, commentId: Number(commentId) });
    if (ok) {
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      onIssueUpdated({ ...issue, commentCount: Math.max(0, issue.commentCount - 1) });
    }
    return ok;
  }

  async function handleApprove() {
    if (!issue) return;
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
      body: approveCommentBody(issue.labels),
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...updated, commentCount: updated.commentCount + 1 });
    }
  }

  async function handleReject(reason: string) {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: labelsAfterRejection(issue.labels),
    });
    if (!updated) return;
    onIssueUpdated(updated);

    const [owner, repo] = issue.repositoryFullName.split("/");
    const body = reason.trim() ? `@claude ${reason.trim()}` : "@claude 内容を見直してください。";
    const created = await createComment({ owner, repo, number: issue.number, body });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...updated, commentCount: updated.commentCount + 1 });
    }
  }

  async function handleWithdraw() {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "closed",
      stateReason: "not_planned",
      labels: labelsAfterApproval(issue.labels),
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleRequestContinuation() {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: labelsAfterRejection(issue.labels),
    });
    if (!updated) return;
    onIssueUpdated(updated);

    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: requestContinuationCommentBody(),
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...updated, commentCount: updated.commentCount + 1 });
    }
  }

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        左の一覧からIssueを選択してください
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex max-w-3xl flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {issue.repositoryFullName}
            {issue.repositoryArchived && (
              <Archive className="size-3.5" aria-label="アーカイブ済み" />
            )}
            {issue.repositoryPrivate && <Lock className="size-3.5" aria-label="プライベート" />}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {canStartImplementation(issue) && (
              <StartImplementationDialog
                issue={issue}
                onIssueUpdated={onIssueUpdated}
                onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
                renderTrigger={(isSubmitting) => (
                  <Button size="sm" disabled={isSubmitting}>
                    {isSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
                    実装を開始
                  </Button>
                )}
              />
            )}
            {canAskClaude(issue) && (
              <AskClaudeDialog
                issue={issue}
                onIssueUpdated={onIssueUpdated}
                onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
                renderTrigger={(isSubmitting) => (
                  <Button variant="outline" size="sm" disabled={isSubmitting}>
                    {isSubmitting ? <Loader2 className="animate-spin" /> : <MessageCircleQuestion />}
                    Claudeに質問する
                  </Button>
                )}
              />
            )}
            {issue.state === "open" && (
              <Button variant="outline" size="sm" asChild>
                <a href={buildClaudeAppUrl(issue)} target="_blank" rel="noreferrer">
                  <Bot />
                  Claudeアプリで開く
                </a>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                GitHubで開く
                <ExternalLink />
              </a>
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="xl:hidden"
              aria-label="プロパティ"
              onClick={() => setIsPropertiesOpen(true)}
            >
              <SlidersHorizontal />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={issue.favorite ? "お気に入りから外す" : "お気に入りに追加"}
              onClick={() => onToggleFavorite(issue)}
            >
              <Star className={cn(issue.favorite && "fill-yellow-400 text-yellow-400")} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal />
                </Button>
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
          </div>
        </div>

        <h1 className="text-lg font-semibold break-words">
          #{issue.number} {issue.title}
        </h1>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Badge variant={issue.state === "open" ? "default" : "secondary"}>
            {issue.state === "open" ? "Open" : closedStateLabel(issue.stateReason)}
          </Badge>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            作成者 <UserAvatar login={issue.author.login} /> {issue.author.login}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            担当者{" "}
            {issue.assignee ? (
              <>
                <UserAvatar login={issue.assignee.login} /> {issue.assignee.login}
              </>
            ) : (
              "未設定"
            )}
          </span>
          <span className="text-muted-foreground">
            作成日 {new Date(issue.createdAt).toLocaleDateString("ja-JP")}
          </span>
          <span className="text-muted-foreground">
            更新日 {new Date(issue.updatedAt).toLocaleDateString("ja-JP")}
          </span>
        </div>

        <WorkflowStatusSteps labels={issue.labels} />
        <div className="flex flex-wrap items-center gap-2">
          <PullRequestLinkBadge link={pullRequestLink} approvalPending={isApprovalPending(issue.labels)} />
          <WorkflowRunStatus run={workflowRun} />
          <CancelWorkflowRunButton
            run={workflowRun}
            runId={workflowRunId}
            repositoryFullName={issue.repositoryFullName}
          />
        </div>

        <Separator />

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} repositoryFullName={issue.repositoryFullName} />
        </div>

        <Separator />

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              コメント <span className="text-muted-foreground">{issue.commentCount}</span>
            </h2>
          </div>
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
            mergeApprovalPending={isMergeApprovalPending(issue.labels)}
            pullRequestLink={pullRequestLink}
            pullRequestCiStatus={pullRequestCiStatus}
            onApprove={handleApprove}
            onReject={handleReject}
            onWithdraw={handleWithdraw}
            onRequestContinuation={handleRequestContinuation}
            isApproving={isSubmitting}
            isRejecting={isCommentSubmitting}
            isWithdrawing={isSubmitting}
            isRequestingContinuation={isCommentSubmitting}
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

      <Sheet open={isPropertiesOpen} onOpenChange={setIsPropertiesOpen}>
        <SheetContent className="w-80">
          <SheetHeader>
            <SheetTitle>プロパティ</SheetTitle>
          </SheetHeader>
          <IssuePropertiesPanel issue={issue} onIssueUpdated={onIssueUpdated} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
