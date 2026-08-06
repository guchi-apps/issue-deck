"use client";

import { useMemo, useRef, useState } from "react";

import {
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  CircleAlert,
  FilePlus2,
  FolderGit2,
  Loader2,
  Lock,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { IssueAiSummary } from "@/components/dashboard/issue-ai-summary";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { MoveIssueDialog } from "@/components/dashboard/move-issue-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { formatRelativeDate } from "@/lib/format-relative-date";
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
import { canStartImplementation } from "@/lib/github/start-implementation";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { useIssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueWorkflowRun } from "@/hooks/use-issue-workflow-run";
import { usePullRequestCiStatus } from "@/hooks/use-pull-request-ci-status";
import { usePullRequestLink } from "@/hooks/use-pull-request-link";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileIssueDetailProps = {
  issue: Issue;
  issues: Issue[];
  repositories: ConnectedRepository[];
  onBack: () => void;
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onIssueDeleted: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateIssue: (repositoryFullName: string) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
};

export function MobileIssueDetail({
  issue,
  issues,
  repositories,
  onBack,
  onEdit,
  onIssueUpdated,
  onIssueDeleted,
  onToggleFavorite,
  onCreateIssue,
  onCreateFollowupIssue,
}: MobileIssueDetailProps) {
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
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  const canMove = repositories.some((repo) => repo.fullName !== issue.repositoryFullName);
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
    setError: setCommentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  const [isImageUploading, setIsImageUploading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastCommentRef = useRef<HTMLLIElement>(null);
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, issue.repositoryFullName),
    [issues, issue.repositoryFullName],
  );
  const pullRequestLink = usePullRequestLink(issue.repositoryFullName, issue.number, comments);
  const { status: pullRequestCiStatus } = usePullRequestCiStatus(
    issue.repositoryFullName,
    pullRequestLink,
    isMergeApprovalPending(issue.labels),
  );
  const {
    mergePullRequest,
    isSubmitting: isMergingPullRequest,
    error: mergePullRequestError,
  } = usePullRequestMergeMutation();
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

  async function handleDelete() {
    const ok = await deleteIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
    });
    if (ok) {
      setIsDeleteDialogOpen(false);
      onIssueDeleted(issue);
      onBack();
    }
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

  async function handleAskClaudeFromComposer() {
    if (!newCommentBody.trim()) return;
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
    await updateLabelsAndComment(labelsAfterApproval(issue.labels), approveCommentBody(issue.labels));
  }

  async function handleReject(reason: string) {
    const body = reason.trim() ? `@claude ${reason.trim()}` : "@claude 内容を見直してください。";
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), body);
  }

  async function handleWithdraw() {
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
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), requestContinuationCommentBody());
  }

  async function handleRequestPrFix(reason: string) {
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), requestPrFixCommentBody(reason));
  }

  async function handleMergePullRequest(): Promise<boolean> {
    if (!pullRequestLink) return false;
    const [owner, repo] = issue.repositoryFullName.split("/");
    return mergePullRequest({ owner, repo, number: pullRequestLink.number });
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" {...swipeBackHandlers}>
      <header className="flex shrink-0 items-center gap-3 border-b p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="-m-3 rounded-full p-3 active:bg-muted"
        >
          <ArrowLeft className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          #{issue.number} {issue.title}
        </span>
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
                className="-m-3 rounded-full p-3 text-primary active:bg-muted disabled:opacity-50"
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
        {canAskClaude(issue) && (
          <AskClaudeDialog
            issue={issue}
            onIssueUpdated={onIssueUpdated}
            onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
            renderTrigger={(isSubmitting) => (
              <button
                type="button"
                disabled={isSubmitting}
                aria-label="Claudeに質問する"
                className="-m-3 rounded-full p-3 text-primary active:bg-muted disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <MessageCircleQuestion className="size-5" />
                )}
              </button>
            )}
          />
        )}
        <button
          type="button"
          onClick={() => onToggleFavorite(issue)}
          aria-label={issue.favorite ? "お気に入りから外す" : "お気に入りに追加"}
          className="-m-3 rounded-full p-3 active:bg-muted"
        >
          <Star
            className={
              issue.favorite ? "size-5 fill-yellow-400 text-yellow-400" : "size-5 text-muted-foreground"
            }
          />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="操作メニュー"
              className="-m-3 rounded-full p-3 active:bg-muted"
            >
              <MoreHorizontal className="size-5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {issue.state === "open" && (
              <DropdownMenuItem asChild>
                <a
                  href={buildClaudeAppUrl(issue)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={handleClaudeAppHandoff}
                >
                  <Bot />
                  Claudeアプリで開く
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onCreateFollowupIssue(issue)}>
              <FilePlus2 />
              引き継いでIssueを作成
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(issue)}>
              <Pencil />
              編集
            </DropdownMenuItem>
            {canMove && (
              <DropdownMenuItem onSelect={() => setIsMoveDialogOpen(true)}>
                <ArrowRightLeft />
                リポジトリを移動
              </DropdownMenuItem>
            )}
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
      </header>

      <div ref={scrollContainerRef} className="flex flex-col gap-4 overflow-y-auto overscroll-contain p-4 pb-20">
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
        <div className="flex flex-wrap items-center gap-2">
          <PullRequestLinkBadge link={pullRequestLink} approvalPending={isApprovalPending(issue.labels)} />
          <CancelWorkflowRunButton
            run={workflowRun}
            runId={workflowRunId}
            repositoryFullName={issue.repositoryFullName}
          />
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
              <SelectTrigger
                className="h-auto gap-1 border-none bg-transparent p-0 text-sm shadow-none hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent"
                disabled={isMetaLoading || isSubmitting}
              >
                <SelectValue placeholder="担当者を選択">
                  <span className="flex items-center gap-1.5">
                    {issue.assignee && <UserAvatar login={issue.assignee.login} />}
                    {issue.assignee?.login ?? "未設定"}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未設定</SelectItem>
                {repoAssignees.map((login) => (
                  <SelectItem key={login} value={login}>
                    <UserAvatar login={login} />
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
                    className="relative -m-1.5 rounded-full p-1.5 after:absolute after:-inset-2.5 hover:opacity-70 disabled:opacity-50"
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
                  className="flex size-11 items-center justify-center rounded-full border text-muted-foreground disabled:opacity-50"
                >
                  <Plus className="size-4" />
                </button>
              }
            />
          </div>
        </div>

        <Separator />

        <IssueAiSummary issue={issue} />

        <Separator />

        {canStartImplementation(issue) && (
          <StartImplementationDialog
            issue={issue}
            onIssueUpdated={onIssueUpdated}
            onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
            renderTrigger={(isSubmitting) => (
              <Button className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
                実装を開始
              </Button>
            )}
          />
        )}

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} repositoryFullName={issue.repositoryFullName} />
        </div>

        <Separator />

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
            onMergePullRequest={handleMergePullRequest}
            isApproving={isSubmitting}
            isRejecting={isCommentSubmitting}
            isWithdrawing={isSubmitting}
            isRequestingContinuation={isCommentSubmitting}
            isRequestingPrFix={isCommentSubmitting}
            isMergingPullRequest={isMergingPullRequest}
            mergePullRequestError={mergePullRequestError}
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

      <ScrollToLatestCommentButton
        containerRef={scrollContainerRef}
        targetRef={lastCommentRef}
        visible={comments.length > 0}
        className="left-1/2 bottom-4 h-11 w-20 -translate-x-1/2"
      />

      <button
        type="button"
        onClick={() => onCreateIssue(issue.repositoryFullName)}
        aria-label="新しいIssueを作成"
        className="absolute right-4 bottom-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-5" />
      </button>

      <DeleteIssueDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        onConfirm={handleDelete}
        isDeleting={isSubmitting}
        error={deleteError}
      />

      <MoveIssueDialog
        open={isMoveDialogOpen}
        onOpenChange={setIsMoveDialogOpen}
        issue={issue}
        repositories={repositories}
        onMoved={onIssueUpdated}
      />
    </div>
  );
}
