"use client";

import { useMemo, useRef, useState } from "react";

import {
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
import { ArtifactPreviewProvider } from "@/components/dashboard/artifact-preview";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { CommentThread } from "@/components/dashboard/comment-thread";
import { DeleteIssueDialog } from "@/components/dashboard/delete-issue-dialog";
import { DeployFailurePanel } from "@/components/dashboard/deploy-failure-panel";
import { IssueArtifactPanel } from "@/components/dashboard/issue-artifact-panel";
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
import { PlanApprovalPanel } from "@/components/dashboard/plan-approval-panel";
import { QuestionAnswerPanel } from "@/components/dashboard/question-answer-panel";
import { PlanReviewButton } from "@/components/dashboard/plan-review-button";
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
import { findPlanRequestForIssue } from "@/lib/dispatch/session-plan-request";
import { findQuestionRequestForIssue } from "@/lib/dispatch/session-question-request";
import {
  LocalSessionApprovalNotice,
  LocalSessionCommentNotice,
  LocalSessionWaitingInputNotice,
} from "@/components/dashboard/local-session-notice";
import { IssueOrderSection } from "@/components/dashboard/issue-order-section";
import { CodeReviewPanel } from "@/components/dashboard/code-review-panel";
import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";
import {
  isIssueExecutionStarted,
  resolveIssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
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
  DropdownMenuSeparator,
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
import { useIssueArtifacts } from "@/hooks/use-issue-artifacts";
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
  dismissCheckUserCommentBody,
  isApprovalPending,
  isMergeApprovalPending,
  labelsAfterApproval,
  labelsAfterCheckUserDismissal,
  labelsAfterRejection,
  rejectCommentBody,
  withoutCheckUserLabels,
  requestContinuationCommentBody,
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";
import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";
import { CLOSE_REASON_LABELS } from "@/lib/github/issue-close";
import { isPlanningPhaseSkipped } from "@/lib/github/planning-phase";
import {
  askClaudeCommentBody,
  canAskClaude,
  canCloseAskRepoQuestion,
  canContinueQuestionFromComposer,
  isQaAnswerPending,
  resolveComposerPrimaryAction,
} from "@/lib/github/ask-claude";
import {
  buildCodeReviewFindingIssueIndex,
  findLatestCodeReviewReport,
  isCodeReviewIssue,
  isCodeReviewPending,
  type CodeReviewFinding,
} from "@/lib/github/code-review";
import { canStartImplementation, startImplementationDisabledReason } from "@/lib/github/start-implementation";
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import { canCreateFollowupFromComment } from "@/lib/github/workflow-status";
import {
  selectVisiblePullRequestLinks,
  summarizeIssuePullRequestStates,
} from "@/lib/issue-pull-requests";
import { checkUserTargetProps } from "@/lib/check-user-focus";
import { parseDeployFailureMeta } from "@/lib/deploy-failure";
import { detectInfraConfigTargets, type InfraConfigTarget } from "@/lib/infra-config-repos";
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
  /**
   * 手作業の中の実機ファイル変更を、管理リポジトリ（`guchi-apps/vps`・`guchi-apps/subpc`）の
   * Issueとして切り出す（#2021）
   */
  onCreateConfigIssue: (issue: Issue, target: InfraConfigTarget) => void;
  /** コードレビューの指摘（#698）を、対象リポジトリのIssueとして起票する下書きを開く */
  onCreateCodeReviewFindingIssue: (issue: Issue, finding: CodeReviewFinding) => void;
  /** 同じリポジトリのコードレビュー（#698）をもう一度実行するダイアログを開く */
  onStartCodeReview: (repositoryFullName: string) => void;
  onSelectRepository: (repositoryFullName: string) => void;
  /** 手作業アシスタント（#1826）をこのIssueから開く */
  onStartManualStepGuide: (startIssueId: string) => void;
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
  onCreateConfigIssue,
  onCreateCodeReviewFindingIssue,
  onStartCodeReview,
  onSelectRepository,
  onStartManualStepGuide,
}: IssueDetailProps) {
  const { comments, isLoading, error, setComments } = useIssueComments(issue);
  const { relations: subIssueRelations } = useIssueSubIssues(issue);
  // セッションが公開したアーティファクト（#2154）。本文・コメント中のclaude.aiリンクを
  // アプリ内プレビューへ差し替えるためにも使うので、セクションより外側で取る
  const { artifacts, reload: reloadArtifacts } = useIssueArtifacts(issue);
  // 手作業Issueが待っている相手の状況（#1705）。スマホの詳細でも同じフックを使う
  const manualStepPrerequisites = useManualStepPrerequisites(issue, issues);
  // 実機のファイル変更を管理リポジトリへ切り出せるか（#2021）。**手作業Issueでしか見ない**
  // ——他のIssueの本文に同じパスが出てきても、それは実行手順ではない
  const infraConfigTargets = useMemo(
    () => (issue && canCompleteManualStep(issue) ? detectInfraConfigTargets(issue.body) : []),
    [issue],
  );
  // デプロイ失敗Issue（#2236）。**判定は本文へ埋めた不可視マーカーだけを見る**——
  // 新しいラベルを14リポジトリへ配り終えるまで機能が半端に効く状態を作らないため。
  const deployFailureMeta = useMemo(() => parseDeployFailureMeta(issue?.body), [issue?.body]);
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
  // 進捗ステッパーの計画フェーズをスキップ表示にするか（#2069）。コメントを持っている
  // この層でだけ判定できる
  const planningSkipped = issue ? isPlanningPhaseSkipped(issue, comments, isLoading) : false;
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

  async function handleClose(stateReason: "completed" | "not_planned", closeReasonLabel?: string) {
    if (!issue) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      state: "closed",
      stateReason,
      closeReasonLabel,
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

  /** コメントを1件投稿し、一覧と件数へ反映する（投稿元の入力欄はそれぞれの呼び出し側が畳む） */
  async function postComment(body: string): Promise<boolean> {
    if (!issue) return false;
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({ owner, repo, number: issue.number, body });
    if (!created) return false;
    setComments((prev) => [...prev, created]);
    onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    return true;
  }

  async function handleCreateComment() {
    if (!issue || !newCommentBody.trim()) return;
    if (await postComment(newCommentBody)) setNewCommentBody("");
  }

  async function handleAskClaudeFromComposer() {
    if (!issue || !newCommentBody.trim()) return;
    if (await postComment(askClaudeCommentBody(newCommentBody))) setNewCommentBody("");
  }

  /**
   * `Ctrl`+`Enter`の宛先（#2345）。**そのとき主ボタンになっている投稿操作へ届かせる。**
   * 従来は常に「コメント」で、質問Issueで続きを聞いたつもりの文章が、誰も読まないコメントとして
   * 積まれていた。**クローズには絶対に割り当てない**ので、`close`のときは「コメント」へ倒す。
   */
  async function handleSubmitPrimary() {
    if (composerPrimaryAction === "question") await handleAskClaudeFromComposer();
    else await handleCreateComment();
  }

  /**
   * ローカルセッションが担当しているIssueの承認欄から押せる3つ（#1903）。
   *
   * **「承認」「修正」をここへ出さないための置き換え。** どちらも`@claude`コメントを投稿するが、
   * `11.local`が付いている間の無人実行は「対応しません」という案内を足して終わるだけで、
   * 走っているセッションにも届かない。
   */
  async function handleApprovalComment(body: string) {
    await postComment(body);
  }

  async function handleApprovalAskClaude(question: string) {
    await postComment(askClaudeCommentBody(question));
  }

  async function handleDismissCheckUser(text?: string) {
    if (!issue) return;
    await updateLabelsAndComment(
      labelsAfterCheckUserDismissal(issue.labels),
      dismissCheckUserCommentBody(text),
    );
  }

  /**
   * 画面から計画に答えた・質問に回答した直後に、手元のIssueから`00.check-user`と理由ラベルを
   * 落とす（#2341）。**外すのはサーバー側**（`POST /api/dispatch/plan-decision`・
   * `/question-answer`）で、ここはその結果を一覧のポーリング（10秒間隔）より先に画面へ映すだけ。
   *
   * これが無いと、押した直後の画面にラベルと「計画の承認が必要です」のカードが残り続け、
   * まだ何か操作が要るように見える（Issueの元になった症状）。`21.plan-required`は残す
   * （フックが外すときと同じ）。
   */
  function handleCheckUserResolved() {
    if (!issue) return;
    const labels = withoutCheckUserLabels(issue.labels);
    if (labels.length === issue.labels.length) return;
    onIssueUpdated({ ...issue, labels, checkUserLabeledAt: null });
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
  // 質問Issueをワンボタンで終える導線の表示条件（#1770）。ヘッダーとコメント欄の下の
  // 2か所で同じ値を使い、片方だけ出る状態を作らない
  const canCloseQuestion = canCloseAskRepoQuestion(issue, comments);
  // コメント欄の下の操作列で、どれを主ボタン（塗りつぶし）にするか（#2345）。**入力欄が空か
  // どうかで付け替える**ので、書き始めた時点で強調が「質問する」へ移る
  const composerPrimaryAction = resolveComposerPrimaryAction(
    issue,
    comments,
    newCommentBody.trim().length > 0,
  );
  // 質問Issueでは、この欄が次の質問を書く場所だと分かるようにする（#2345）
  const composerPlaceholder = canContinueQuestionFromComposer(issue, comments)
    ? "続けて質問する場合はここへ..."
    : "コメントを追加...";
  // コードレビューIssue（#698）の結果。**いちばん新しい結果だけ**をパネルに出す
  const codeReview = isCodeReviewIssue(issue)
    ? {
        report: findLatestCodeReviewReport(comments),
        isPending: isCodeReviewPending(comments),
        // 同じ指摘を2回起票しないための照合（#698）。**同じリポジトリの同じタイトル**だけを見る
        // （レビューを回し直すと同じ指摘が返るため、無いと同じIssueが何件も立つ）
        createdFindingIssues: buildCodeReviewFindingIssueIndex(issues, issue.repositoryFullName),
      }
    : null;
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
  // 押せる「GitHub Actionsで開始」が残っていた。
  // **GitHub Actionsの実行中も同じく出さない**（#2032）。ジョブもセッションも無いまま
  // 「サブPCで開始」だけが残り、Actionsと同じブランチをサブPCが別に進めてしまっていた。
  // 実行状況は既にこの画面が持っている（`useIssueWorkflowRun`）ので、取得口は増やさない
  const executionPending = isIssueExecutionPending({
    job: dispatchJob,
    blockingSession,
    actionsRun: workflowRun,
  });
  // 主導線（塗りつぶしの「実装を開始」）は`11.local`でも引っ込める（#1815）。ジョブ・セッションが
  // 画面へ届くまでの間、押す前とまったく同じボタンが残り、効かなかったように見えていた
  const executionStarted = isIssueExecutionStarted({
    job: dispatchJob,
    blockingSession,
    labels: issue.labels,
  });
  // 開始の主導線を出すか。`StartLocalSessionButton`の起動ボタンは、これが出ていないときだけ出す
  // （#1349。両方出すと「サブPCで開始」が2つ並ぶ）
  const showStartDialog = canStartImplementation(issue) && !executionStarted;
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
  // 計画への返事待ち（#2061）。**待っている間、端末には承認プロンプトが出ていない**ので、
  // ここが唯一の答える場所になる（切れると従来どおり端末のプロンプトへ戻る）
  // **テストの差し込みや古い応答では欠けうる**ので、無ければ「待っているものは無い」として読む
  // （`use-dispatch-state.ts`の`hasActiveJob`が`manualStepRuns`をこう扱っているのと同じ）
  const planRequest = findPlanRequestForIssue(
    dispatch.planRequests ?? [],
    issue.repositoryFullName,
    issue.number,
  );
  // 質問への回答待ち（#2189）。計画の返事待ちと同じ扱いで、**待っている間、端末には
  // 選択フォームが出ていない**ので、ここが唯一の答える場所になる
  const questionRequest = findQuestionRequestForIssue(
    dispatch.questionRequests ?? [],
    issue.repositoryFullName,
    issue.number,
  );
  // 走っているセッションが入力待ちのときは、承認・修正ボタンを出さずRemote Controlへ寄せる（#1417）。
  // 入力待ちでは`00.check-user`が自動で付き、人が答えた時点で自動で外れる（`session-notify.sh`）
  const sessionWaitingInput = isSessionWaitingInput(issueSession);
  // 生きているセッションかどうか（#1903）。承認欄の案内を「届かない」と「終了している」で
  // 分けるのに使う（`isSessionWaitingInput`が`ALIVE`でなければfalseを返すのと同じ考え方）
  const sessionAlive = issueSession?.state === "ALIVE";
  // セッションの一覧が届くまでは、確認待ちの案内も承認欄も形を決めない（#1810。#1666と同じ理由）。
  // 取得前の`sessions`は`[]`なので`sessionWaitingInput`は必ずfalseになり、承認欄へ送る案内を
  // 出してからRemote Controlの案内へ書き換わっていた
  const sessionStatePending = !dispatch.isLoaded;
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
    // ローカルが担当しているIssueでは「内容がエージェントへ渡ります」と案内しない（#1903）
    localSession: !executionTarget.expectsActionsRun,
    sessionAlive,
    remoteControlUrl: issueSession ? summarizeIssueSession(issueSession).remoteControlUrl : null,
    hasPullRequestSection: visiblePullRequestLinks.length > 0,
    // 計画への返事を画面から送れる間は、行き先をRemote Controlではなく計画パネルにする（#2061）
    planDecisionPending: planRequest?.status === "WAITING",
    questionAnswerPending: questionRequest?.status === "WAITING",
    sessionStatePending,
  });

  return (
    // 本文・コメントの中のclaude.aiリンクもプレビューへ差し替えるので、詳細の全体を包む（#2154）
    <ArtifactPreviewProvider artifacts={artifacts}>
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
              {showStartDialog && (
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
              {/* 「Claudeに質問する」はここに置かない（#1913）。コメント欄の下の「質問する」と
                  投稿されるコメントが同一（`askClaudeCommentBody`）で、あちらは本文をメンション
                  補完・画像添付付きの入力欄で書けるぶん上位互換だった。ヘッダーに置くと、
                  上のトップバーの「横断質問」とも見分けが付かない */}
              {canCloseQuestion && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => handleClose("completed")}
                >
                  <XCircle />
                  回答を確認してクローズ
                </Button>
              )}
              {/* サブPCへ積んだジョブの状態（順番待ち・起動中・失敗）を出す場所（#1248）。
                  起動ボタンは「実装を開始」のトリガーが出ていないときだけ出す（#1349）。
                  あちらの文言は既定の実行先そのもの（#1262）なので、両方出すと
                  「サブPCで開始」が2つ並ぶ。もう走っているIssueではどちらも出さない（#1667）。
                  `11.local`だけが付いている状態（#1815）ではここが唯一の起動導線になる
                  ——主導線は引っ込めるが、落ちたセッションの立て直しまで塞がない */}
              <StartLocalSessionButton
                issue={issue}
                onIssueUpdated={onIssueUpdated}
                showStartButton={!showStartDialog && !executionPending}
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
                          {/* クローズ理由ラベル（#2178）。区切り線から下は「計画外の内訳」で、
                              どれも`not_planned`でクローズしつつ`90.Close: *`を1枚付ける。
                              ダイアログを挟まずクリック1回で終える（上2つと操作を揃える） */}
                          <DropdownMenuSeparator />
                          {CLOSE_REASON_LABELS.map((reason) => (
                            <DropdownMenuItem
                              key={reason.name}
                              className="whitespace-nowrap text-xs"
                              disabled={isSubmitting}
                              onSelect={() => handleClose("not_planned", reason.name)}
                            >
                              {reason.label}
                            </DropdownMenuItem>
                          ))}
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

        {/* 下端はpb-16（4rem）を空ける（#1793）。画面下中央に浮いている
            ScrollToLatestCommentButtonがbottom-4・md:h-7で下端から2.75remを占めるため、
            p-4（1rem）のままだと最下部までスクロールしたときコメント入力欄の操作列
            （「コメント」「回答を確認してクローズ」など）へボタンが重なる */}
        <div className="flex flex-col gap-3 p-4 pb-16">
          {/* 進捗・ジョブ・セッション・回答待ち・実行キャンセルを1枚に集約する（#1577）。
              走っているものが1つも無いIssueでは何も描かない */}
          <IssueStatusCard
            issue={issue}
            onIssueUpdated={onIssueUpdated}
            dispatch={dispatch}
            dispatchJob={dispatchJob}
            issueSession={issueSession}
            executionTarget={executionTarget}
            workflowRun={workflowRun}
            workflowRunId={workflowRunId}
            qaAnswerPending={qaAnswerPending}
            checkUserGuidance={checkUserGuidance}
            planningSkipped={planningSkipped}
          />

          {/* 質問の回答（#2189）。**計画パネルのすぐ上**に置く——計画を出したあとに質問する
              ことはあり、そのとき待たれているのは新しい方（質問）になる */}
          {questionRequest && (
            <div {...checkUserTargetProps("question")}>
              {/* **質問が変われば作り直す**（#2158と同じ理由。Issue詳細はIssueを切り替えても
                  マウントされたままなので、`key`が無いと選んだ内容が次の質問へ持ち越される） */}
              <QuestionAnswerPanel
                key={questionRequest.id}
                request={questionRequest}
                session={issueSession}
                dispatch={dispatch}
                onCheckUserResolved={handleCheckUserResolved}
              />
            </div>
          )}

          {/* 計画の承認・修正（#2061）。**セッション表示のすぐ下・対応PRより上**に置く。
              待っている間セッションは止まっているので、このIssueで今いちばん急ぐ操作になる */}
          {planRequest && (
            <div {...checkUserTargetProps("plan")}>
              {/* **計画が変われば作り直す**（#2158）。Issue詳細はIssueを切り替えても
                  マウントされたままなので、`key`が無いと押した結果や書きかけの修正本文が
                  次の計画へ持ち越される */}
              <PlanApprovalPanel
                key={planRequest.id}
                request={planRequest}
                session={issueSession}
                dispatch={dispatch}
                onCheckUserResolved={handleCheckUserResolved}
              />
            </div>
          )}

          {/* アーティファクト（#2154）。**計画パネルのすぐ下**に置く——`25.artifact-required`の
              基本形は「計画と見た目を1回のやり取りで承認する」なので、承認する場所の隣に
              見た目への入口が要る。畳めるセクションではなく独立したカード（#2190） */}
          <IssueArtifactPanel artifacts={artifacts} onReload={reloadArtifacts} />

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

          {/* コードレビューの結果（#698）。**本文より上に置く**——レビューIssueの本文は
              「何を見るか」の指定だけで、読みたいのは結果の方 */}
          {codeReview && (
            <CodeReviewPanel
              report={codeReview.report}
              isPending={codeReview.isPending}
              createdFindingIssues={codeReview.createdFindingIssues}
              onRestartReview={() => onStartCodeReview(issue.repositoryFullName)}
              onCreateFindingIssue={(finding) => onCreateCodeReviewFindingIssue(issue, finding)}
            />
          )}

          {/* デプロイ失敗Issueの案内と出口（#2236）。**本文より上に置く**——このIssueを
              開いた人がやることはたいてい「もう一度流す」の1つだけで、説明を読ませる前に
              直す手段を出す */}
          {deployFailureMeta && <DeployFailurePanel meta={deployFailureMeta} />}

          {/* 手作業Issueの案内と出口（#1280）。説明（「やること」）のすぐ上に置く */}
          {canCompleteManualStep(issue) && (
            <ManualStepPanel
              isSubmitting={isSubmitting}
              onComplete={() => handleClose("completed")}
              onSkip={() => handleClose("not_planned")}
              onStartGuide={() => onStartManualStepGuide(issue.id)}
              prerequisites={manualStepPrerequisites.prerequisites}
              prerequisiteSummary={manualStepPrerequisites.summary}
              dependents={manualStepPrerequisites.dependents}
              verifiedAt={issue.manualStepVerifiedAt}
              body={issue.body}
              configTargets={infraConfigTargets}
              onCreateConfigIssue={(target) => onCreateConfigIssue(issue, target)}
              repositoryFullName={issue.repositoryFullName}
            />
          )}

          {/* 実施順序（#2003）。手作業Issueでは上の手作業パネルの中に出しているので、
              ここでは出さない（同じものが2回並ぶ） */}
          {!canCompleteManualStep(issue) && (
            <IssueOrderSection
              prerequisites={manualStepPrerequisites.prerequisites}
              prerequisiteSummary={manualStepPrerequisites.summary}
              dependents={manualStepPrerequisites.dependents}
              repositoryFullName={issue.repositoryFullName}
              idPrefix="pc"
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
              <SubIssueProgress
                relations={subIssueRelations}
                baseRepositoryFullName={issue.repositoryFullName}
                showHeading={false}
              />
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
                  <LocalSessionWaitingInputNotice
                    session={issueSession}
                    planDecisionPending={planRequest?.status === "WAITING"}
                    questionAnswerPending={questionRequest?.status === "WAITING"}
                  />
                ) : (
                  <LocalSessionApprovalNotice session={issueSession} />
                )
              }
              planReviewAction={
                /* 計画の承認待ちのときだけ出す（#1855）。**自動起動が主経路**で、ここは
                   走らなかったとき・計画を直してもう一度かけたいときの入口 */
                checkUserReason(issue.labels) === "plan" ? (
                  <PlanReviewButton issue={issue} dispatch={dispatch} />
                ) : undefined
              }
              sessionWaitingInput={sessionWaitingInput}
              sessionStatePending={sessionStatePending}
              localSession={!executionTarget.expectsActionsRun}
              sessionAlive={sessionAlive}
              canAskClaude={canAskClaude(issue)}
              qaAnswerPending={qaAnswerPending}
              onComment={handleApprovalComment}
              onAskClaude={handleApprovalAskClaude}
              onDismissCheckUser={handleDismissCheckUser}
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
                placeholder={composerPlaceholder}
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
                    handleSubmitPrimary();
                  }
                }}
              />
              <BodyCleanupButton value={newCommentBody} onCleaned={setNewCommentBody} />
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* Ctrl+Enterの宛先は状態で変わる（#2345）。主ボタンの塗りつぶしと文言を
                    一致させて、どちらへ飛ぶのかを押す前に読めるようにする */}
                <span className="mr-auto text-xs text-muted-foreground">
                  <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[0.7rem]">
                    Ctrl
                  </kbd>
                  <span className="mx-0.5">+</span>
                  <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[0.7rem]">
                    Enter
                  </kbd>
                  <span className="ml-1">
                    で{composerPrimaryAction === "question" ? "質問" : "コメント"}
                  </span>
                </span>
                {canCreateFollowupFromComment(issue) && (
                  <Button variant="outline" onClick={() => onCreateFollowupIssue(issue)}>
                    <FilePlus2 />
                    引き継いでIssueを作成
                  </Button>
                )}
                {/* ヘッダーの「Claudeに質問する」を畳んだぶん、ダイアログが出していた説明を
                    ここへ引き継ぐ（#1913） */}
                {canAskClaude(issue) && (
                  <Button
                    variant={composerPrimaryAction === "question" ? "default" : "outline"}
                    title="入力した内容をClaudeへの質問として投稿します。コードは変更されません。回答はコメントとして返るまで数十秒〜数分かかります。"
                    onClick={handleAskClaudeFromComposer}
                    disabled={!newCommentBody.trim() || isCommentSubmitting || isImageUploading}
                  >
                    <MessageCircleQuestion />
                    質問する
                  </Button>
                )}
                {/* 質問Issueでは「コメント」を主ボタンにしない（#1770）。さらに枠線でもなく
                    枠なしまで沈める（#2345）——質問Issueへ書いたふつうのコメントは誰も読まない */}
                <Button
                  variant={composerPrimaryAction === "comment" ? "default" : "ghost"}
                  onClick={handleCreateComment}
                  disabled={!newCommentBody.trim() || isCommentSubmitting || isImageUploading}
                >
                  {isCommentSubmitting && <Loader2 className="animate-spin" />}
                  {isCommentSubmitting ? "送信中..." : "コメント"}
                </Button>
                {/* 回答を読み終えた位置に出口を置く（#1770）。ヘッダーにも同じ操作があるが、
                    コメントを読み進めるとそちらは押す対象として遠い。書きかけがあるときは
                    主ボタンを「質問する」へ譲って枠線まで下がる（#2345） */}
                {canCloseQuestion && (
                  <Button
                    variant={composerPrimaryAction === "close" ? "default" : "outline"}
                    disabled={isSubmitting}
                    onClick={() => handleClose("completed")}
                  >
                    <XCircle />
                    回答を確認してクローズ
                  </Button>
                )}
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
    </ArtifactPreviewProvider>
  );
}
