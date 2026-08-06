"use client";

import { useMemo, useRef, useState } from "react";

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
  Trash2,
  XCircle,
} from "lucide-react";

import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { IssueAiSummary } from "@/components/dashboard/issue-ai-summary";
import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { PullRequestLinkBadge } from "@/components/dashboard/pull-request-link-badge";
import { ScrollToLatestCommentButton } from "@/components/dashboard/scroll-to-latest-comment-button";
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
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
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
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";
import { askClaudeCommentBody, canAskClaude } from "@/lib/github/ask-claude";
import { buildClaudeAppHandoffCommentBody, buildClaudeAppUrl } from "@/lib/github/claude-app";
import { extractLatestPullRequestLink } from "@/lib/github/pull-request-link";
import { canStartImplementation } from "@/lib/github/start-implementation";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type IssueDetailProps = {
  issue: Issue | null;
  issues: Issue[];
  repositories: ConnectedRepository[];
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onIssueDeleted: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
};

export function IssueDetail({
  issue,
  issues,
  repositories,
  onEdit,
  onIssueUpdated,
  onIssueDeleted,
  onToggleFavorite,
  onCreateFollowupIssue,
}: IssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const commentSummary = useIssueCommentSummaries(issue);
  const {
    run: workflowRun,
    runId: workflowRunId,
    commentId: workflowRunCommentId,
  } = useIssueWorkflowRun(issue, comments);
  const {
    updateIssue,
    deleteIssue,
    isSubmitting,
    error: deleteError,
    setError: setDeleteError,
  } = useIssueMutations();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
    setError: setCommentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastCommentRef = useRef<HTMLLIElement>(null);
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

  async function handleDelete() {
    if (!issue) return;
    const ok = await deleteIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
    });
    if (ok) {
      setIsDeleteDialogOpen(false);
      onIssueDeleted(issue);
    }
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

  async function handleAskClaudeFromComposer() {
    if (!issue || !newCommentBody.trim()) return;
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(newCommentBody),
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      setNewCommentBody("");
      onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    }
  }

  function handleClaudeAppHandoff() {
    if (!issue) return;
    const [owner, repo] = issue.repositoryFullName.split("/");
    createComment({
      owner,
      repo,
      number: issue.number,
      body: buildClaudeAppHandoffCommentBody(),
    }).then((created) => {
      if (!created) return;
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    });
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

  /**
   * ラベル更新→コメント投稿の順で行う承認系操作の共通処理。
   * コメント投稿（個人のGitHub OAuthトークン使用）はトークン失効時に失敗しうるため、
   * その場合はラベル更新前の状態にロールバックし、「ラベルは外れたが実装は再開されない」
   * 不整合状態を防ぐ（#421）。
   *
   * ラベル更新はissue-deckのGitHub Appが行うためGitHub上はbotの操作として記録され、
   * issues.unlabeledイベントだけでは実装の再開がトリガーされない（#173）。個人アカウントで
   * 投稿されるコメントを続けて送ることで、issue_commentトリガー経由で確実に再開させる。
   */
  async function updateLabelsAndComment(newLabels: string[], commentBody: string) {
    if (!issue) return;
    const originalLabels = issue.labels.map((label) => label.name);
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: newLabels,
    });
    if (!updated) return;
    onIssueUpdated(updated);

    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: commentBody,
    });
    if (created) {
      setComments((prev) => [...prev, created]);
      onIssueUpdated({ ...updated, commentCount: updated.commentCount + 1 });
      return;
    }

    const rolledBack = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: originalLabels,
    });
    if (rolledBack) onIssueUpdated(rolledBack);
    setCommentMutationError((prev) =>
      rolledBack ? withRollbackNotice(prev ?? "") : withRollbackFailureNotice(prev ?? ""),
    );
  }

  async function handleApprove() {
    if (!issue) return;
    await updateLabelsAndComment(labelsAfterApproval(issue.labels), approveCommentBody(issue.labels));
  }

  async function handleReject(reason: string) {
    if (!issue) return;
    const body = reason.trim() ? `@claude ${reason.trim()}` : "@claude 内容を見直してください。";
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), body);
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
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), requestContinuationCommentBody());
  }

  async function handleRequestPrFix(reason: string) {
    if (!issue) return;
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), requestPrFixCommentBody(reason));
  }

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        左の一覧からIssueを選択してください
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
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
                  <a
                    href={buildClaudeAppUrl(issue)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={handleClaudeAppHandoff}
                  >
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
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={isSubmitting}
                    onSelect={() => {
                      setDeleteError(null);
                      setIsDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 />
                    Issueを削除
                  </DropdownMenuItem>
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
            <CancelWorkflowRunButton
              run={workflowRun}
              runId={workflowRunId}
              repositoryFullName={issue.repositoryFullName}
            />
          </div>

          <Separator />

          <IssueAiSummary issue={issue} />

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
              workflowRun={workflowRun}
              workflowRunCommentId={workflowRunCommentId}
              onApprove={handleApprove}
              onReject={handleReject}
              onWithdraw={handleWithdraw}
              onRequestContinuation={handleRequestContinuation}
              onRequestPrFix={handleRequestPrFix}
              isApproving={isSubmitting}
              isRejecting={isCommentSubmitting}
              isWithdrawing={isSubmitting}
              isRequestingContinuation={isCommentSubmitting}
              isRequestingPrFix={isCommentSubmitting}
              lastCommentRef={lastCommentRef}
              commentSummary={commentSummary}
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
                repositoryFullName={issue.repositoryFullName}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleCreateComment();
                  }
                }}
              />
              <div className="flex flex-wrap justify-end gap-2">
                {canCreateFollowupFromComment(issue) && (
                  <Button variant="outline" onClick={() => onCreateFollowupIssue(issue)}>
                    <FilePlus2 />
                    引き継いでIssueを作成
                  </Button>
                )}
                {canAskClaude(issue) && (
                  <Button
                    variant="outline"
                    onClick={handleAskClaudeFromComposer}
                    disabled={!newCommentBody.trim() || isCommentSubmitting || isImageUploading}
                  >
                    <MessageCircleQuestion />
                    質問する
                  </Button>
                )}
                <Button
                  onClick={handleCreateComment}
                  disabled={!newCommentBody.trim() || isCommentSubmitting || isImageUploading}
                >
                  {isCommentSubmitting && <Loader2 className="animate-spin" />}
                  {isCommentSubmitting ? "送信中..." : "コメント"}
                </Button>
              </div>
              {commentMutationError && (
                <p className="text-sm text-destructive">{commentMutationError}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <ScrollToLatestCommentButton
        containerRef={scrollContainerRef}
        targetRef={lastCommentRef}
        visible={comments.length > 0}
        className="right-4 bottom-4"
      />

      <Sheet open={isPropertiesOpen} onOpenChange={setIsPropertiesOpen}>
        <SheetContent className="w-80">
          <SheetHeader>
            <SheetTitle>プロパティ</SheetTitle>
          </SheetHeader>
          <IssuePropertiesPanel
            issue={issue}
            repositories={repositories}
            onIssueUpdated={onIssueUpdated}
          />
        </SheetContent>
      </Sheet>

      <DeleteIssueDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        onConfirm={handleDelete}
        isDeleting={isSubmitting}
        error={deleteError}
      />
    </div>
  );
}
