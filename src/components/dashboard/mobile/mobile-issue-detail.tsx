"use client";

import { useMemo, useRef, useState } from "react";

import {
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  ExternalLink,
  FilePlus2,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { IssueAiSummarySection } from "@/components/dashboard/issue-ai-summary";
import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import {
  IssuePullRequestList,
  IssuePullRequestStateCounts,
} from "@/components/dashboard/issue-pull-request-list";
import { IssueStatusCard } from "@/components/dashboard/issue-status-card";
import { IssueSummaryDialog } from "@/components/dashboard/issue-summary-dialog";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MobileIssuePropertiesSection } from "@/components/dashboard/mobile/mobile-issue-properties-section";
import { MobileIssueSummaryCard } from "@/components/dashboard/mobile/mobile-issue-summary-card";
import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import {
  moveDestinationRepositories,
  MoveIssueDialog,
} from "@/components/dashboard/move-issue-dialog";
import { ScrollToLatestCommentButton } from "@/components/dashboard/scroll-to-latest-comment-button";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { SubIssueProgress } from "@/components/dashboard/sub-issue-progress";
import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import {
  findBlockingSession,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  isIssueExecutionPending,
  resolveDefaultDispatchHost,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  LocalSessionApprovalNotice,
  LocalSessionCommentNotice,
  LocalSessionWaitingInputNotice,
} from "@/components/dashboard/local-session-notice";
import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";
import { resolveIssueExecutionTarget } from "@/lib/dispatch/issue-execution-target";
import {
  findSessionForIssue,
  isSessionWaitingInput,
  summarizeIssueSession,
} from "@/lib/dispatch/issue-session";
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
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import {
  approveCommentBody,
  canCompleteManualStep,
  checkUserReason,
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
import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";
import {
  askClaudeCommentBody,
  canAskClaude,
  canCloseAskRepoQuestion,
  isQaAnswerPending,
} from "@/lib/github/ask-claude";
import { buildClaudeAppHandoffCommentBody, buildClaudeAppUrl } from "@/lib/github/claude-app";
import { canStartImplementation, startImplementationDisabledReason } from "@/lib/github/start-implementation";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import {
  selectVisiblePullRequestLinks,
  summarizeIssuePullRequestStates,
} from "@/lib/issue-pull-requests";
import { checkUserTargetProps } from "@/lib/check-user-focus";
import { resolveMergeCheckReasons } from "@/lib/merge-check-reasons";
import { summarizeSubIssueProgress } from "@/lib/sub-issue-progress";
import { useFirstUnreadCommentIndex } from "@/hooks/use-first-unread-comment-index";
import { useIssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueSubIssues } from "@/hooks/use-issue-sub-issues";
import { useIssueTaskList } from "@/hooks/use-issue-task-list";
import { useManualStepPrerequisites } from "@/hooks/use-manual-step-prerequisites";
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
  const taskList = useIssueTaskList(issue, onIssueUpdated);
  // 手作業Issueが待っている相手の状況（#1705）。PCの詳細と同じフック・同じ部品を使う
  const manualStepPrerequisites = useManualStepPrerequisites(issue, issues);
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
  // 「Claudeに質問する」は⋯メニューから開くので、開閉はここで持つ（#1646）。
  // `DropdownMenuItem`をトリガーにすると、メニューが閉じた時点でダイアログごと消える
  const [isAskDialogOpen, setIsAskDialogOpen] = useState(false);
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
  // もう走り始めているIssueでは開始の導線を出さない（#1667）。積んだ直後は進捗がまだ
  // `Ready`のままで、既定の実行先だけがGitHub Actionsへ移るため、「順番待ち」の真下に
  // 押せる「GitHub Actionsで開始」が全幅で残っていた
  const executionPending = isIssueExecutionPending({ job: dispatchJob, blockingSession });
  // ホストの一覧が届くまでは実行先を名乗らない（#1666）。空の一覧のまま名乗ると
  // 「GitHub Actionsで開始」と出した直後に「サブPCで開始」へ書き変わる
  const startLabel = !dispatch.isLoaded
    ? "実装を開始"
    : defaultDispatchHost
      ? `${formatDispatchHostName(defaultDispatchHost)}で開始`
      : "GitHub Actionsで開始";
  // 起動したセッションの様子（#1264）。ジョブの状態表示は「tmuxが立った」までで終わっている
  const issueSession = findSessionForIssue(
    dispatch.sessions,
    issue.repositoryFullName,
    issue.number,
  );
  // 走っているセッションが入力待ちのときは、承認・修正ボタンを出さずRemote Controlへ寄せる（#1417）。
  // 入力待ちでは`00.check-user`が自動で付き、人が答えた時点で自動で外れる（`session-notify.sh`）
  const sessionWaitingInput = isSessionWaitingInput(issueSession);
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
  const [isImageUploading, setIsImageUploading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const targetCommentRef = useRef<HTMLLIElement>(null);
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, issue.repositoryFullName),
    [issues, issue.repositoryFullName],
  );
  const qaAnswerPending = isQaAnswerPending(comments);
  const pullRequestLinks = usePullRequestLinks(issue.repositoryFullName, issue.number, comments);
  const mergeApprovalPending = isMergeApprovalPending(issue, comments);
  // 自動マージされなかった理由（#1631）。対応PR一覧とコメント欄のマージ待ちカードへ同じ値を渡す
  const mergeCheckReasons = resolveMergeCheckReasons(issue.labels, comments);
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
  // 対応PRのセクションは、一覧が実際に描く行が1件以上あるときだけ出す（#1577）。
  // 判定を`IssuePullRequestList`と共有しないと、行が無いのに空の枠だけが残る
  const visiblePullRequestLinks = selectVisiblePullRequestLinks(pullRequestLinks, pullRequests);
  const pullRequestSummary = summarizeIssuePullRequestStates(
    pullRequests,
    visiblePullRequestLinks.length,
  );
  const subIssueSummary = summarizeSubIssueProgress(subIssueRelations.children);
  // 確認待ちのときに、次にどこの何を押せばよいかを上部から案内する（#1663）。PCの詳細と同じ
  const checkUserGuidance = resolveCheckUserGuidance({
    reason: checkUserReason(issue.labels),
    placement: "status",
    sessionWaitingInput,
    remoteControlUrl: issueSession ? summarizeIssueSession(issueSession).remoteControlUrl : null,
    hasPullRequestSection: visiblePullRequestLinks.length > 0,
  });

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
        {/* ヘッダーに残す操作は★と⋯だけにする（#1646）。以前は▶（実装を開始）と?（Claudeに
            質問する）も並べていたが、▶は本文の全幅ボタンと表示条件が同一（`canStartImplementation`）で
            必ず二重になり、?は`canAskClaude`＝openなIssューすべてで常時居座るため、390px幅では
            タイトルに120pxしか残らなかった。どちらも操作自体は消さず、▶は本文のボタンへ一本化し、
            ?と「質問を終えてクローズ」は下の⋯メニューへ移した。
            マージボタンはIssue単位ではなくPR単位の操作なので、対応PR一覧の各行に置いている（#1339） */}
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
            {/* ヘッダーから移した2つ（#1646）。先頭へ置き、押す回数の多い順を保つ */}
            {canAskClaude(issue) && (
              <DropdownMenuItem
                className="whitespace-nowrap text-xs"
                onSelect={() => setIsAskDialogOpen(true)}
              >
                <MessageCircleQuestion className="size-3.5" />
                Claudeに質問する
              </DropdownMenuItem>
            )}
            {canCloseAskRepoQuestion(issue, comments) && (
              <DropdownMenuItem
                className="whitespace-nowrap text-xs"
                disabled={isSubmitting}
                onSelect={() => handleClose("completed")}
              >
                <XCircle className="size-3.5" />
                質問を終えてクローズ
              </DropdownMenuItem>
            )}
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
      {/* flex-1を外さない（#1664）。付けないと`flex: 0 1 auto`のまま＝この領域の高さが
          「中身の高さから縮んだ結果」として決まる。見た目の高さは同じでも、ポーリングの
          更新・画像やコメントの読み込みで中身の高さが変わるたびにflexの縮小計算が走り、
          スクロール領域の箱ごと再レイアウトされる。iOSのホーム画面アプリ（standalone PWA）
          ではこのときスクローラの描画内容が失われ、レイアウトは正しいのに背景も文字も
          描かれない領域が残る（その後Reactが更新した「7分前」などの一部だけが描き直される）。
          ブラウザで再現しないのは、URLバーの伸縮でビューポートが頻繁に変わり全面の描き直しに
          紛れるため。他のモバイル画面（home/settings/repos/issue-list）はいずれもflex-1を
          付けており、この画面だけが例外だった。規約は
          mobile-screen-scroll-container.test.tsで固定している */}
      <div
        ref={scrollContainerRef}
        data-capture-scroll-bottom
        className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 pb-20"
      >
        {/* リポジトリ・タイトル・状態・進捗・担当者・コメント数・更新・ラベルを1枚へ畳む（#1646）。
            以前はこれらが独立した6ブロックとして縦に並び、説明が初期表示から押し出されていた */}
        <MobileIssueSummaryCard issue={issue} onSelectRepository={onSelectRepository} />

        {/* 進捗ステップ・積んだジョブ・セッションの様子・横断質問・回答待ち・実行のキャンセルを
            1枚に集約する（#1577）。PCの詳細と同じものを使う。走っているものが1つも無いIssueでは
            カードごと描かれない */}
        <IssueStatusCard
          issue={issue}
          dispatch={dispatch}
          dispatchJob={dispatchJob}
          issueSession={issueSession}
          executionTarget={executionTarget}
          workflowRun={workflowRun}
          workflowRunId={workflowRunId}
          qaAnswerPending={qaAnswerPending}
          checkUserGuidance={checkUserGuidance}
        />

        {canStartImplementation(issue) && !executionPending && (
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
            出ていないときだけ出す（#1349）。もう走っているIssueではどちらも出さない（#1667） */}
        <StartLocalSessionButton
          issue={issue}
          onIssueUpdated={onIssueUpdated}
          fullWidth
          showStartButton={!canStartImplementation(issue) && !executionPending}
          /* 積んだジョブの状態は`IssueStatusCard`が出すので、ここでは出さない（#1646）。
             両方に出すと「順番待ち」が同じ画面に2つ並ぶ。PCの詳細と同じ渡し方 */
          showJobStatus={false}
          dispatch={dispatch}
        />

        {/* 手作業Issueの案内と出口（#1280）。説明（「やること」）のすぐ上に置く */}
        {canCompleteManualStep(issue) && (
          <ManualStepPanel
            isSubmitting={isSubmitting}
            onComplete={() => handleClose("completed")}
            onSkip={() => handleClose("not_planned")}
            prerequisites={manualStepPrerequisites.prerequisites}
            prerequisiteSummary={manualStepPrerequisites.summary}
            repositoryFullName={issue.repositoryFullName}
          />
        )}

        {/* 対応PRはIssue本文より上に置く。マージボタンをこの各行の中だけに置いても、
            コメント欄まで下げずに押せる位置を保つため（#1288の意図・#1339）。
            既定では畳み、マージ待ちのときだけ開いたままにする（#1577・#1646） */}
        {visiblePullRequestLinks.length > 0 && (
          <IssueDetailSection
            id="pull-requests"
            /* 上部の案内から「対応PRへ移動」で飛んでくる先（#1663） */
            targetProps={checkUserTargetProps("pull-requests")}
            title={mergeApprovalPending ? "対応PR・マージ待ち" : "対応PR"}
            count={pullRequestSummary.total}
            forceOpen={mergeApprovalPending}
            tone={mergeApprovalPending ? "attention" : "default"}
            summary={<IssuePullRequestStateCounts buckets={pullRequestSummary.buckets} />}
          >
            <IssuePullRequestList
              variant="plain"
              /* 自動マージされなかった理由をマージボタンと同じ枠の中に出す（#1631）。PCと同じ */
              notice={
                mergeApprovalPending ? (
                  <MergeCheckReasonNotice reasons={mergeCheckReasons} />
                ) : undefined
              }
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
          </IssueDetailSection>
        )}

        {/* 子イシューの進捗は説明より上に出す（#1340）。畳んでいても完了率は行に残す（#1646） */}
        {hasSubIssueRelations && (
          <IssueDetailSection
            id="sub-issues"
            title={subIssueRelations.children.length > 0 ? "子Issue" : "親Issue"}
            count={subIssueRelations.childCount}
            summary={
              subIssueRelations.children.length > 0 ? (
                <>
                  <span
                    className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuenow={subIssueSummary.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="子Issueの完了率"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${subIssueSummary.percent}%` }}
                    />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {subIssueSummary.done} / {subIssueSummary.total} 完了
                  </span>
                </>
              ) : (
                <span className="truncate text-xs text-muted-foreground">
                  #{subIssueRelations.parent?.number} {subIssueRelations.parent?.title}
                </span>
              )
            }
          >
            <SubIssueProgress
              relations={subIssueRelations}
              baseRepositoryFullName={issue.repositoryFullName}
              showHeading={false}
            />
          </IssueDetailSection>
        )}

        <IssueAiSummarySection issue={issue} />

        {/* 担当者・ラベル・日付は「変えたいときに触るもの」なので畳んでおく（#1646） */}
        <MobileIssuePropertiesSection
          issue={issue}
          isSubmitting={isSubmitting}
          onToggleLabel={toggleLabel}
          onAssigneeChange={handleAssigneeChange}
        />

        <Separator />

        {/* 見出しの重さを持つのは説明とコメントだけにする（#1577・#1646）。補助情報は
            折りたたみの小さなラベルになっており、形だけで主従が読み取れる */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">説明</h2>
            {/* 本文にタスクリストがあるときだけ進捗を出す（#1486） */}
            {taskList.progress.total > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground">
                タスク {taskList.progress.completed} / {taskList.progress.total} 完了
              </span>
            )}
          </div>
          <ApiErrorMessage message={taskList.error} />
          <MarkdownBody
            content={taskList.body}
            repositoryFullName={issue.repositoryFullName}
            onToggleTask={taskList.toggleTask}
            isTaskToggling={taskList.isToggling}
          />
        </div>

        <Separator />

        <div>
          <h2 className="mb-3 text-base font-semibold">
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
            checkUserReason={checkUserReason(issue.labels)}
            localSessionNotice={
              executionTarget.expectsActionsRun ? undefined : sessionWaitingInput ? (
                <LocalSessionWaitingInputNotice session={issueSession} />
              ) : (
                <LocalSessionApprovalNotice session={issueSession} />
              )
            }
            sessionWaitingInput={sessionWaitingInput}
            mergeApprovalPending={mergeApprovalPending}
            mergeCheckReasons={mergeCheckReasons}
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
            <BodyCleanupButton value={newCommentBody} onCleaned={setNewCommentBody} />
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

      {/* トリガーは⋯メニューの項目なので、ここではダイアログ本体だけを置く（#1646） */}
      <AskClaudeDialog
        issue={issue}
        open={isAskDialogOpen}
        onOpenChange={setIsAskDialogOpen}
        onIssueUpdated={onIssueUpdated}
        onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
      />
    </div>
  );
}
