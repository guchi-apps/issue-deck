"use client";

import { useMemo, useRef, useState } from "react";

import {
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  CircleAlert,
  ExternalLink,
  FilePlus2,
  FolderGit2,
  Loader2,
  Lock,
  MessageCircleQuestion,
  Mic,
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

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { IssueAiSummary } from "@/components/dashboard/issue-ai-summary";
import { IssuePullRequestList } from "@/components/dashboard/issue-pull-request-list";
import { IssueSummaryDialog } from "@/components/dashboard/issue-summary-dialog";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import {
  moveDestinationRepositories,
  MoveIssueDialog,
} from "@/components/dashboard/move-issue-dialog";
import { ScrollToLatestCommentButton } from "@/components/dashboard/scroll-to-latest-comment-button";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { SubIssueProgress } from "@/components/dashboard/sub-issue-progress";
import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStatusSteps } from "@/components/dashboard/workflow-status-steps";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import {
  findBlockingSession,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultDispatchHost,
} from "@/lib/dispatch/dispatch-job";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import {
  LocalSessionApprovalNotice,
  LocalSessionCommentNotice,
} from "@/components/dashboard/local-session-notice";
import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";
import { resolveIssueExecutionTarget } from "@/lib/dispatch/issue-execution-target";
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
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
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  approveCommentBody,
  canCompleteManualStep,
  isApprovalPending,
  isMergeApprovalPending,
  labelsAfterApproval,
  labelsAfterRejection,
  rejectCommentBody,
  requestContinuationCommentBody,
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";
import {
  askClaudeCommentBody,
  canAskClaude,
  canCloseAskRepoQuestion,
  isQaAnswerPending,
} from "@/lib/github/ask-claude";
import { buildClaudeAppHandoffCommentBody, buildClaudeAppUrl } from "@/lib/github/claude-app";
import { canStartImplementation, startImplementationDisabledReason } from "@/lib/github/start-implementation";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { useFirstUnreadCommentIndex } from "@/hooks/use-first-unread-comment-index";
import { useIssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSubIssues } from "@/hooks/use-issue-sub-issues";
import { useIssueWorkflowRun } from "@/hooks/use-issue-workflow-run";
import { useIssuePullRequests } from "@/hooks/use-issue-pull-requests";
import { usePullRequestLinks } from "@/hooks/use-pull-request-link";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileIssueDetailProps = {
  issue: Issue;
  issues: Issue[];
  repositories: ConnectedRepository[];
  /** ログイン中ユーザーのlogin名。コメント欄で自分のコメントを右寄せ表示するために使う */
  currentUserLogin: string | null;
  onBack: () => void;
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onIssueDeleted: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateIssue: (repositoryFullName: string) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
  onSelectRepository: (repositoryFullName: string) => void;
};

/** 表示中のIssueでまだマージしていないときに渡す空集合。毎レンダーの再生成を避ける */
const EMPTY_MERGED_NUMBERS: ReadonlySet<number> = new Set();

export function MobileIssueDetail({
  issue,
  issues,
  repositories,
  currentUserLogin,
  onBack,
  onEdit,
  onIssueUpdated,
  onIssueDeleted,
  onToggleFavorite,
  onCreateIssue,
  onCreateFollowupIssue,
  onSelectRepository,
}: MobileIssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const { relations: subIssueRelations } = useIssueSubIssues(issue);
  const hasSubIssueRelations =
    subIssueRelations.parent !== null || subIssueRelations.children.length > 0;
  const commentSummary = useIssueCommentSummaries(issue);
  const { index: targetCommentIndex, hasUnread } = useFirstUnreadCommentIndex(issue, comments);
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
  const [isSummaryDialogOpen, setIsSummaryDialogOpen] = useState(false);
  const canMove = moveDestinationRepositories(repositories, issue.repositoryFullName).length > 0;
  // **▶ごと無効化しない**（#1262）。実行先の選択がダイアログの中にあるため、押せないと
  // サブPCでの起動まで塞がる。理由はダイアログへ渡してActionsの選択肢だけを落とす
  const actionsDisabledReason = startImplementationDisabledReason(
    repositories.find((repo) => repo.fullName === issue.repositoryFullName)?.hasClaudeWorkflow,
  );
  // ディスパッチ状態はこの画面で1回だけ取得し、起動ボタン・実行先の表示へ配る（#1262）
  const dispatch = useDispatchState(true);
  const dispatchJob = findDispatchJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  // 起動済み（セッション生存中）のIssueは積ませない（#1311）。判定はAPI側
  // （`enqueueDispatchJob`）と同じものを使う
  const blockingSession = findBlockingSession({
    sessions: dispatch.sessions,
    hosts: dispatch.hosts,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });
  const defaultDispatchHost = resolveDefaultDispatchHost({
    hosts: dispatch.hosts,
    repositoryFullName: issue.repositoryFullName,
    hasActiveJob: dispatchJob !== null && isActiveDispatchJobStatus(dispatchJob.status),
    blockingSession,
  });
  const startLabel = defaultDispatchHost ? `${defaultDispatchHost}で開始` : "GitHub Actionsで開始";
  // 起動したセッションの様子（#1264）。ジョブの状態表示は「tmuxが立った」までで終わっている
  const issueSession = findSessionForIssue(
    dispatch.sessions,
    issue.repositoryFullName,
    issue.number,
  );
  const executionTarget = resolveIssueExecutionTarget({
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
    labels: issue.labels,
    jobs: dispatch.jobs,
    sessions: dispatch.sessions,
  });
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
    setError: setCommentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  const {
    isGenerating: isCleaningUpComment,
    error: commentCleanupError,
    notConfigured: commentCleanupNotConfigured,
    generate: generateCommentCleanup,
  } = useIssueBodyCleanup();
  const [isImageUploading, setIsImageUploading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const targetCommentRef = useRef<HTMLLIElement>(null);
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, issue.repositoryFullName),
    [issues, issue.repositoryFullName],
  );
  const qaAnswerPending = isQaAnswerPending(comments);
  const pullRequestLinks = usePullRequestLinks(issue.repositoryFullName, issue.number, comments);
  const mergeApprovalPending = isMergeApprovalPending(issue, comments);
  const { pullRequests, refresh: refreshPullRequests } = useIssuePullRequests(
    issue.repositoryFullName,
    issue.number,
    pullRequestLinks,
    mergeApprovalPending,
  );
  const {
    mergePullRequest,
    isSubmitting: isMergingPullRequest,
    error: mergePullRequestError,
  } = usePullRequestMergeMutation();
  // マージ済みの表示は、対応PR一覧を出している2箇所（本文の上・コメント欄のマージ待ちカード）で
  // 共有する。GitHub側の反映を待つ間だけの楽観表示（#1288・#1339）。画面内のリンクから別の
  // Issueへ移ってもこのコンポーネントは再マウントされないため、どのIssueで押したかを一緒に持つ
  const [mergedPullRequests, setMergedPullRequests] = useState<{
    issueKey: string;
    numbers: ReadonlySet<number>;
  } | null>(null);
  const [mergeTargetNumber, setMergeTargetNumber] = useState<number | null>(null);
  const issueKey = `${issue.repositoryFullName}#${issue.number}`;
  const mergedPullRequestNumbers =
    mergedPullRequests?.issueKey === issueKey ? mergedPullRequests.numbers : EMPTY_MERGED_NUMBERS;
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

  async function handleGenerateCommentCleanup() {
    const result = await generateCommentCleanup(newCommentBody);
    if (!result) return;
    setNewCommentBody(result.text);
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

  async function handleApprove(text?: string) {
    await updateLabelsAndComment(
      labelsAfterApproval(issue.labels),
      approveCommentBody(issue.labels, text),
    );
  }

  async function handleReject(reason: string) {
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), rejectCommentBody(issue.labels, reason));
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

  async function handleMergePullRequest(pullRequestNumber: number): Promise<boolean> {
    setMergeTargetNumber(pullRequestNumber);
    const [owner, repo] = issue.repositoryFullName.split("/");
    return mergePullRequest({ owner, repo, number: pullRequestNumber });
  }

  function handlePullRequestMerged(pullRequestNumber: number) {
    setMergedPullRequests((prev) => ({
      issueKey,
      numbers: new Set([...(prev?.issueKey === issueKey ? prev.numbers : []), pullRequestNumber]),
    }));
    // 楽観表示のあと、GitHub側の状態（マージ済み・CI）を取り直して実データへ寄せる
    refreshPullRequests();
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
        <button
          type="button"
          onClick={() => setIsSummaryDialogOpen(true)}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
        >
          #{issue.number} {issue.title}
        </button>
        {/* マージボタンはIssue単位ではなくPR単位の操作なので、ヘッダーではなく
            対応PR一覧（IssuePullRequestList）の各行に置いている（#1339） */}
        {canStartImplementation(issue) && (
          <StartImplementationDialog
            issue={issue}
            onIssueUpdated={onIssueUpdated}
            onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
            /* スマホではヘッダーに置けるのがこの▶だけなので、実行先（GitHub Actions／
               サブPC）もここで選ばせる（#1248） */
            includeDispatchTargets
            dispatch={dispatch}
            actionsDisabledReason={actionsDisabledReason}
            comments={comments}
            subIssueRelations={subIssueRelations}
            /* `localSessionCommand`は渡さない。ターミナルへ貼るためのものなので、
               スマホでコピーできても貼る先が無い（#1263） */
            renderTrigger={(isSubmitting) => (
              <button
                type="button"
                disabled={isSubmitting}
                aria-label={startLabel}
                title={startLabel}
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
        {canCloseAskRepoQuestion(issue, comments) && (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleClose("completed")}
            aria-label="質問を終えてクローズ"
            className="-m-3 rounded-full p-3 text-primary active:bg-muted disabled:opacity-50"
          >
            <XCircle className="size-5" />
          </button>
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
          <DropdownMenuContent align="end" className="w-fit min-w-0">
            {issue.state === "open" && (
              <DropdownMenuItem asChild className="whitespace-nowrap text-xs">
                <a
                  href={buildClaudeAppUrl(issue)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={handleClaudeAppHandoff}
                >
                  <Bot className="size-3.5" />
                  Claudeアプリで開く
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild className="whitespace-nowrap text-xs">
              <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                GitHubで開く
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="whitespace-nowrap text-xs"
              onSelect={() => onCreateFollowupIssue(issue)}
            >
              <FilePlus2 className="size-3.5" />
              引き継いでIssueを作成
            </DropdownMenuItem>
            <DropdownMenuItem className="whitespace-nowrap text-xs" onSelect={() => onEdit(issue)}>
              <Pencil className="size-3.5" />
              編集
            </DropdownMenuItem>
            {canMove && (
              <DropdownMenuItem
                className="whitespace-nowrap text-xs"
                onSelect={() => setIsMoveDialogOpen(true)}
              >
                <ArrowRightLeft className="size-3.5" />
                リポジトリを移動
              </DropdownMenuItem>
            )}
            {issue.state === "open" ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="whitespace-nowrap text-xs" disabled={isSubmitting}>
                  <XCircle className="size-3.5" />
                  クローズする
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-fit min-w-0">
                    <DropdownMenuItem
                      className="whitespace-nowrap text-xs"
                      disabled={isSubmitting}
                      onSelect={() => handleClose("completed")}
                    >
                      完了としてクローズ
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="whitespace-nowrap text-xs"
                      disabled={isSubmitting}
                      onSelect={() => handleClose("not_planned")}
                    >
                      計画外としてクローズ
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem
                className="whitespace-nowrap text-xs"
                disabled={isSubmitting}
                onSelect={handleReopen}
              >
                <RotateCcw className="size-3.5" />
                再オープンする
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="whitespace-nowrap text-xs"
              variant="destructive"
              disabled={isSubmitting}
              onSelect={() => {
                setDeleteError(null);
                setIsDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="size-3.5" />
              Issueを削除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* data-capture-scroll-bottomは、外側のページがoverflow-hiddenのためfullPage撮影に
          写らないこの内部スクロール領域の下端を、scripts/capture-screenshots.mjsが撮影前に
          スクロールして写すための目印 */}
      <div
        ref={scrollContainerRef}
        data-capture-scroll-bottom
        className="flex flex-col gap-4 overflow-y-auto overscroll-contain p-4 pb-20"
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2 className="size-3.5" />
          <button
            type="button"
            onClick={() => onSelectRepository(issue.repositoryFullName)}
            className="hover:text-foreground hover:underline"
          >
            {issue.repositoryFullName}
          </button>
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

        <WorkflowStatusSteps
          labels={issue.labels}
          projectStatus={issue.projectStatus}
          executionTarget={executionTarget}
        />
        {issueSession && (
          <IssueSessionStatus session={issueSession} dispatch={dispatch} align="start" />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {qaAnswerPending && (
            <span className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full bg-blue-500/15 px-3 py-1 text-xs font-medium text-blue-600 ring-1 ring-inset ring-blue-500 md:min-h-0 md:px-2.5 dark:text-blue-400">
              <MessageCircleQuestion className="size-3" />
              Claudeの回答待ち
            </span>
          )}
          <CancelWorkflowRunButton
            run={workflowRun}
            runId={workflowRunId}
            repositoryFullName={issue.repositoryFullName}
          />
        </div>

        {/* 対応PRはIssue本文より上に置く。マージボタンをこの各行の中だけに置いても、
            コメント欄まで下げずに押せる位置を保つため（#1288の意図・#1339） */}
        <IssuePullRequestList
          links={pullRequestLinks}
          pullRequests={pullRequests}
          mergeApprovalPending={mergeApprovalPending}
          onMerge={handleMergePullRequest}
          onMerged={handlePullRequestMerged}
          mergedNumbers={mergedPullRequestNumbers}
          mergeTargetNumber={mergeTargetNumber}
          isMerging={isMergingPullRequest}
          mergeError={mergePullRequestError}
        />

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
            includeDispatchTargets
            dispatch={dispatch}
            actionsDisabledReason={actionsDisabledReason}
            comments={comments}
            subIssueRelations={subIssueRelations}
            renderTrigger={(isSubmitting) => (
              <Button className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
                {startLabel}
              </Button>
            )}
          />
        )}

        {/* サブPCへのディスパッチ（#1180）。積んだ結果（順番待ち・起動中・失敗）を出す場所も
            兼ねる。サブPCの申告が無ければこの導線ごと出ない。
            起動ボタンは、すぐ上の「実装を開始」（既定の実行先を文言にしている・#1262）が
            出ていないときだけ出す（#1349） */}
        <StartLocalSessionButton
          issue={issue}
          onIssueUpdated={onIssueUpdated}
          fullWidth
          showStartButton={!canStartImplementation(issue)}
          dispatch={dispatch}
        />

        {/* 手作業Issueの案内と出口（#1280）。説明（「やること」）のすぐ上に置く */}
        {canCompleteManualStep(issue) && (
          <ManualStepPanel
            isSubmitting={isSubmitting}
            onComplete={() => handleClose("completed")}
            onSkip={() => handleClose("not_planned")}
          />
        )}

        {/* 子イシューの進捗はAI要約と説明の間に置く（#1340）。モバイルでは実装開始などの
            操作導線を上に残したいため、説明のすぐ上へ差し込む */}
        {hasSubIssueRelations && (
          <>
            <SubIssueProgress relations={subIssueRelations} />
            <Separator />
          </>
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
            currentUserLogin={currentUserLogin}
            repositoryFullName={issue.repositoryFullName}
            issueSuggestions={issueSuggestions}
            onUpdate={handleUpdateComment}
            onDelete={handleDeleteComment}
            isUpdating={isCommentSubmitting}
            approvalPending={isApprovalPending(issue.labels)}
            localSessionNotice={
              executionTarget.expectsActionsRun ? undefined : (
                <LocalSessionApprovalNotice session={issueSession} />
              )
            }
            mergeApprovalPending={mergeApprovalPending}
            pullRequestLinks={pullRequestLinks}
            pullRequests={pullRequests}
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
            mergeTargetNumber={mergeTargetNumber}
            mergedPullRequestNumbers={mergedPullRequestNumbers}
            onPullRequestMerged={handlePullRequestMerged}
            targetCommentIndex={targetCommentIndex}
            targetCommentRef={targetCommentRef}
            commentSummary={commentSummary}
          />

          <div className="mt-4 flex flex-col gap-2">
            {/* PC側と同じ理由でここにも出す（#1287）。外出先から書く経路こそ、
                届いていないことに気づきにくい */}
            {!executionTarget.expectsActionsRun && (
              <LocalSessionCommentNotice session={issueSession} />
            )}
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
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="xs"
                className="w-fit"
                disabled={!newCommentBody.trim() || isCleaningUpComment}
                onClick={handleGenerateCommentCleanup}
              >
                {isCleaningUpComment ? <Loader2 className="animate-spin" /> : <Mic />}
                音声入力を整理
              </Button>
              {commentCleanupNotConfigured && (
                <p className="text-xs text-muted-foreground">
                  Claudeのトークンが設定されていません
                </p>
              )}
              {commentCleanupError && (
                <p className="text-xs text-destructive">{commentCleanupError}</p>
              )}
            </div>
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
            <ApiErrorMessage message={commentMutationError} />
          </div>
        </div>
      </div>

      <ScrollToLatestCommentButton
        key={issue.id}
        containerRef={scrollContainerRef}
        targetRef={targetCommentRef}
        visible={comments.length > 0}
        hasUnread={hasUnread}
        className="left-1/2 bottom-4 -translate-x-1/2"
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

      <IssueSummaryDialog
        issue={issue}
        open={isSummaryDialogOpen}
        onOpenChange={setIsSummaryDialogOpen}
      />
    </div>
  );
}
