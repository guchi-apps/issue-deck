"use client";

import { useMemo, useRef, useState } from "react";

import {
  Bot,
  ExternalLink,
  FilePlus2,
  Loader2,
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

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { IssueAiSummarySection } from "@/components/dashboard/issue-ai-summary";
import { IssueDetailHeader } from "@/components/dashboard/issue-detail-header";
import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import {
  IssuePullRequestList,
  IssuePullRequestStateCounts,
} from "@/components/dashboard/issue-pull-request-list";
import { IssueStatusCard } from "@/components/dashboard/issue-status-card";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { ScrollToLatestCommentButton } from "@/components/dashboard/scroll-to-latest-comment-button";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import { SubIssueProgress } from "@/components/dashboard/sub-issue-progress";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useFirstUnreadCommentIndex } from "@/hooks/use-first-unread-comment-index";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useIssueComments } from "@/hooks/use-issue-comments";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueSubIssues } from "@/hooks/use-issue-sub-issues";
import { useIssueTaskList } from "@/hooks/use-issue-task-list";
import { useManualStepPrerequisites } from "@/hooks/use-manual-step-prerequisites";
import { useIssueWorkflowRun } from "@/hooks/use-issue-workflow-run";
import { useIssuePullRequests } from "@/hooks/use-issue-pull-requests";
import { usePullRequestLinks } from "@/hooks/use-pull-request-link";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
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
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import {
  selectVisiblePullRequestLinks,
  summarizeIssuePullRequestStates,
} from "@/lib/issue-pull-requests";
import { checkUserTargetProps } from "@/lib/check-user-focus";
import { resolveMergeCheckReasons } from "@/lib/merge-check-reasons";
import { summarizeSubIssueProgress } from "@/lib/sub-issue-progress";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/** 表示中のIssueでまだマージしていないときに渡す空集合。毎レンダーの再生成を避ける */
const EMPTY_MERGED_NUMBERS: ReadonlySet<number> = new Set();

type IssueDetailProps = {
  issue: Issue | null;
  issues: Issue[];
  repositories: ConnectedRepository[];
  /** ログイン中ユーザーのlogin名。コメント欄で自分のコメントを右寄せ表示するために使う */
  currentUserLogin: string | null;
  onEdit: (issue: Issue) => void;
  onIssueUpdated: (issue: Issue) => void;
  onIssueDeleted: (issue: Issue) => void;
  onToggleFavorite: (issue: Issue) => void;
  onCreateFollowupIssue: (issue: Issue) => void;
  onSelectRepository: (repositoryFullName: string) => void;
};

export function IssueDetail({
  issue,
  issues,
  repositories,
  currentUserLogin,
  onEdit,
  onIssueUpdated,
  onIssueDeleted,
  onToggleFavorite,
  onCreateFollowupIssue,
  onSelectRepository,
}: IssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const { relations: subIssueRelations } = useIssueSubIssues(issue);
  // 手作業Issueが待っている相手の状況（#1705）。スマホの詳細でも同じフックを使う
  const manualStepPrerequisites = useManualStepPrerequisites(issue, issues);
  const taskList = useIssueTaskList(issue, onIssueUpdated);
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
  const {
    createComment,
    updateComment,
    deleteComment,
    isSubmitting: isCommentSubmitting,
    error: commentMutationError,
    setError: setCommentMutationError,
  } = useIssueCommentMutations();
  const [newCommentBody, setNewCommentBody] = useState("");
  // ディスパッチ状態はこの画面で1回だけ取得し、起動ボタン・実行先の表示へ配る（#1262）。
  // 子（StartImplementationDialog・StartLocalSessionButton）が各自で取得すると、
  // 同じ画面のためにポーリングが何本も走る
  const dispatch = useDispatchState(true);
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const targetCommentRef = useRef<HTMLLIElement>(null);
  const issueSuggestions = useMemo(
    () => (issue ? getRepoIssueSuggestions(issues, issue.repositoryFullName) : []),
    [issues, issue],
  );
  const qaAnswerPending = isQaAnswerPending(comments);
  const pullRequestLinks = usePullRequestLinks(
    issue?.repositoryFullName ?? null,
    issue?.number ?? null,
    comments,
  );
  const { pullRequests, refresh: refreshPullRequests } = useIssuePullRequests(
    issue?.repositoryFullName ?? null,
    issue?.number ?? null,
    pullRequestLinks,
    issue ? isMergeApprovalPending(issue, comments) : false,
  );
  const {
    mergePullRequest,
    isSubmitting: isMergingPullRequest,
    error: mergePullRequestError,
  } = usePullRequestMergeMutation();
  // マージ済みの表示は、対応PR一覧を出している2箇所（本文の上・コメント欄のマージ待ちカード）で
  // 共有する。GitHub側の反映を待つ間だけの楽観表示なので、どのIssueで押したかを一緒に持ち、
  // 別のIssueへ切り替えたときに持ち越さない
  const [mergedPullRequests, setMergedPullRequests] = useState<{
    issueKey: string;
    numbers: ReadonlySet<number>;
  } | null>(null);
  const [mergeTargetNumber, setMergeTargetNumber] = useState<number | null>(null);
  const issueKey = issue ? `${issue.repositoryFullName}#${issue.number}` : "";
  const mergedPullRequestNumbers =
    mergedPullRequests?.issueKey === issueKey ? mergedPullRequests.numbers : EMPTY_MERGED_NUMBERS;

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

  async function handleApprove(text?: string) {
    if (!issue) return;
    await updateLabelsAndComment(
      labelsAfterApproval(issue.labels),
      approveCommentBody(issue.labels, text),
    );
  }

  async function handleReject(reason: string) {
    if (!issue) return;
    await updateLabelsAndComment(labelsAfterRejection(issue.labels), rejectCommentBody(issue.labels, reason));
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

  async function handleMergePullRequest(pullRequestNumber: number): Promise<boolean> {
    if (!issue) return false;
    setMergeTargetNumber(pullRequestNumber);
    const [owner, repo] = issue.repositoryFullName.split("/");
    return mergePullRequest({ owner, repo, number: pullRequestNumber });
  }

  function handlePullRequestMerged(pullRequestNumber: number) {
    setMergedPullRequests((prev) => ({
      issueKey,
      numbers: new Set([
        ...(prev?.issueKey === issueKey ? prev.numbers : []),
        pullRequestNumber,
      ]),
    }));
    // 楽観表示のあと、GitHub側の状態（マージ済み・CI）を取り直して実データへ寄せる
    refreshPullRequests();
  }

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        左の一覧からIssueを選択してください
      </div>
    );
  }

  const currentRepository = repositories.find((repo) => repo.fullName === issue.repositoryFullName);
  const mergeApprovalPending = isMergeApprovalPending(issue, comments);
  // 自動マージされなかった理由（#1631）。マージ待ちのときしか描かないので、ここで常に
  // 解決しておいて上の対応PRセクションとコメント欄のマージ待ちカードへ同じ値を渡す
  const mergeCheckReasons = resolveMergeCheckReasons(issue.labels, comments);
  // **トリガーボタンは無効化しない**（#1262）。実行先の選択がダイアログの中にある以上、
  // 押せないとサブPCでの起動まで塞がる。理由はダイアログへ渡し、Actionsの選択肢だけを落とす
  const actionsDisabledReason = startImplementationDisabledReason(
    currentRepository?.hasClaudeWorkflow,
  );
  // 押す前に実行先が分かるよう、ボタンの文言を既定の実行先そのものにする（#1262）。
  // 既定の決め方はダイアログ側と同じ関数を使う
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
  // `Ready`のままで、既定の実行先だけがGitHub Actionsへ移るため、「順番待ち」の隣に
  // 押せる「GitHub Actionsで開始」が残っていた
  const executionPending = isIssueExecutionPending({ job: dispatchJob, blockingSession });
  // ホストの一覧が届くまでは実行先を名乗らない（#1666）。空の一覧のまま名乗ると
  // 「GitHub Actionsで開始」と出した直後に「サブPCで開始」へ書き変わる
  const startLabel = !dispatch.isLoaded
    ? "実装を開始"
    : defaultDispatchHost
      ? `${formatDispatchHostName(defaultDispatchHost)}で開始`
      : "GitHub Actionsで開始";
  // 着手後もどちらで動いているかが分かるようにする（#1262）
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
  // 「起動コマンドをコピー」は、対象リポジトリがローカル起動プロトコルに適合しているときだけ
  // 出す（#1073）。貼った先で受け口が止まるだけの選択肢を並べないため。
  const localSessionCommand = canStartLocalSession(currentRepository?.hasLocalStartScript)
    ? buildLocalSessionCommand(issue.repositoryFullName, issue.number)
    : null;
  // 対応PRのセクションは、一覧が実際に描く行が1件以上あるときだけ出す（#1577）。
  // 判定を`IssuePullRequestList`と共有しないと、行が無いのに空の枠だけが残る
  const visiblePullRequestLinks = selectVisiblePullRequestLinks(pullRequestLinks, pullRequests);
  const pullRequestSummary = summarizeIssuePullRequestStates(
    pullRequests,
    visiblePullRequestLinks.length,
  );
  const subIssueSummary = summarizeSubIssueProgress(subIssueRelations.children);
  // 確認待ちのときに、次にどこの何を押せばよいかを上部から案内する（#1663）。行き先の判定に
  // マージ待ちかどうかと対応PRセクションの有無が要るため、解決はここで行う
  const checkUserGuidance = resolveCheckUserGuidance({
    reason: checkUserReason(issue.labels),
    placement: "status",
    sessionWaitingInput,
    remoteControlUrl: issueSession ? summarizeIssueSession(issueSession).remoteControlUrl : null,
    hasPullRequestSection: visiblePullRequestLinks.length > 0,
  });

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* data-capture-scroll-bottomは、外側のページがoverflow-hiddenのためfullPage撮影に
          写らないこの内部スクロール領域の下端を、scripts/capture-screenshots.mjsが撮影前に
          スクロールして写すための目印 */}
      <div
        ref={scrollContainerRef}
        data-capture-scroll-bottom
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        {/* ヘッダーはスクロールしても残る（#1577）。中身の状態はここでは持たず、
            操作ボタンだけを渡す */}
        <IssueDetailHeader
          issue={issue}
          onSelectRepository={onSelectRepository}
          actions={
            <>
              {/* マージボタンはIssue単位ではなくPR単位の操作なので、この操作列ではなく
                  対応PR一覧（IssuePullRequestList）の各行に置いている（#1339） */}
              {canStartImplementation(issue) && !executionPending && (
                <StartImplementationDialog
                  issue={issue}
                  onIssueUpdated={onIssueUpdated}
                  onCommentCreated={(comment) => setComments((prev) => [...prev, comment])}
                  includeDispatchTargets
                  dispatch={dispatch}
                  actionsDisabledReason={actionsDisabledReason}
                  comments={comments}
                  localSessionCommand={localSessionCommand}
                  subIssueRelations={subIssueRelations}
                  renderTrigger={(isSubmitting) => (
                    <Button size="sm" disabled={isSubmitting}>
                      {isSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
                      {startLabel}
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
              {canCloseAskRepoQuestion(issue, comments) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => handleClose("completed")}
                >
                  <XCircle />
                  質問を終えてクローズ
                </Button>
              )}
              {/* サブPCへ積んだジョブの状態（順番待ち・起動中・失敗）を出す場所（#1248）。
                  起動ボタンは「実装を開始」のトリガーが出ていないときだけ出す（#1349）。
                  あちらの文言は既定の実行先そのもの（#1262）なので、両方出すと
                  「サブPCで開始」が2つ並ぶ。もう走っているIssueではどちらも出さない（#1667） */}
              <StartLocalSessionButton
                issue={issue}
                onIssueUpdated={onIssueUpdated}
                showStartButton={!canStartImplementation(issue) && !executionPending}
                showJobStatus={false}
                dispatch={dispatch}
              />
              {/* 主操作（開始・質問）と同じ大きさで並べない（#1577）。常時出る補助的な導線なので
                  アイコンだけにして、主操作の位置が折り返しで動くのを減らす */}
              <Button variant="outline" size="icon" aria-label="GitHubで開く" title="GitHubで開く" asChild>
                <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
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
                <DropdownMenuContent align="end" className="w-fit min-w-0">
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
            </>
          }
        />

        <div className="flex flex-col gap-3 p-4">
          {/* 進捗・ジョブ・セッション・回答待ち・実行キャンセルを1枚に集約する（#1577）。
              走っているものが1つも無いIssueでは何も描かない */}
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

          {/* 対応PRはIssue本文より上に置く。マージボタンをこの各行の中だけに置いても、
              コメント欄まで下げずに押せる位置を保つため（#1288の意図・#1339）。
              既定では畳み、マージ待ちのときだけ開いたままにする（#1577） */}
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
                /* なぜ自動マージされず自分の操作が要るのかを、マージボタンと同じ枠の中に
                   出す（#1631）。理由はコメントの奥にしかなく、押す場所から離れていた */
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

          {/* 子イシューの進捗は説明より上に出す（#1340）。本文を読み始める前に分割済みの
              子イシューがあることに気付けるよう、畳んでいても完了率は見えるようにする */}
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
              <SubIssueProgress relations={subIssueRelations} showHeading={false} />
            </IssueDetailSection>
          )}

          <IssueAiSummarySection issue={issue} />

          <Separator />

          {/* 説明とコメントだけが本来の見出しの重さを持つ（#1577）。補助情報（対応PR・子Issue・
              AI要約）は畳めるセクションの小さなラベルにしてあり、形で主従が読み取れる */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">説明</h2>
              {/* 本文にタスクリストがあるときだけ進捗を出す。手作業Issueの「やること」を
                  消し込みながら進めるための目印（#1486） */}
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
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">
                コメント <span className="text-muted-foreground">{issue.commentCount}</span>
              </h2>
            </div>
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
              {/* ローカルで走っているIssueでは、ここへ書いたコメントがセッションへ届かない
                  （#1287）。承認欄の案内（#1264）は承認待ちのときしか出ないが、届かないのは
                  承認コメントに限らないため、入力欄そのものにも出す */}
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
                {issue.state === "open" && (
                  <Button variant="outline" asChild>
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
      </div>

      <ScrollToLatestCommentButton
        key={issue.id}
        containerRef={scrollContainerRef}
        targetRef={targetCommentRef}
        visible={comments.length > 0}
        hasUnread={hasUnread}
        className="left-1/2 bottom-4 -translate-x-1/2"
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
