"use client";

import { type RefObject, useState, type ReactNode } from "react";

import {
  Ban,
  Check,
  Loader2,
  Mic,
  MoreHorizontal,
  Pencil,
  RotateCw,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";

import { CommentAiSummary } from "@/components/dashboard/comment-ai-summary";
import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { IssueMergeButton } from "@/components/dashboard/issue-merge-button";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MentionTextarea, type IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowRunStatus } from "@/components/dashboard/workflow-run-status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import type { IssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import type { WorkflowRunInfo } from "@/hooks/use-issue-workflow-run";
import { isAskClaudeQuestionComment, isQaAnswerComment } from "@/lib/github/ask-claude";
import {
  COMMENT_AGENT_PROFILES,
  commentAgentRole,
  isMarkedAutomationComment,
  resolveCommentSource,
} from "@/lib/github/comment-source";
import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import { isBotComment } from "@/lib/github/is-bot-comment";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import { cn } from "@/lib/utils";
import type { IssueComment } from "@/types/issue";

/** この文字数を超えるコメント本文にのみAI要約の生成ボタンを表示する */
const LONG_COMMENT_THRESHOLD = 400;

type CommentThreadProps = {
  comments: IssueComment[];
  isLoading?: boolean;
  error?: string | null;
  /** ログイン中ユーザーのlogin名。一致するコメントは右寄せの吹き出しで表示する。未ログイン時はnull */
  currentUserLogin?: string | null;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  onUpdate: (commentId: string, body: string) => Promise<boolean>;
  onDelete: (commentId: string) => Promise<boolean>;
  /** trueの場合、コメントの編集保存中であることを示す（保存ボタン・テキスト欄を無効化する） */
  isUpdating?: boolean;
  /** trueの場合、直近のbotコメントの下に承認・修正・取り下げボタン（またはPRマージ案内）を表示する（00.check-userラベルが付いているissue用） */
  approvalPending?: boolean;
  /** サブPC実行中に承認が空振りすることを伝える案内（#1264） */
  localSessionNotice?: ReactNode;
  /** trueの場合、承認・修正・取り下げボタンの代わりにPRマージを促す案内を表示する（PRマージ待ちで00.check-userが付いているissue用） */
  mergeApprovalPending?: boolean;
  /** mergeApprovalPending時に案内とあわせて表示する対応PRへのリンク。取得できない場合はnull */
  pullRequestLink?: PullRequestLink | null;
  /** mergeApprovalPending時に対応PRの最新コミットのCI状態を併せて表示する。取得できない場合はnull */
  pullRequestCiStatus?: PullRequestCiStatus | null;
  /** 直近の「実行ログ:」リンクが指すGitHub Actions実行の状態。取得できない場合はnull */
  workflowRun?: WorkflowRunInfo | null;
  /** workflowRunに対応する「実行ログ:」リンクを含むコメントのID。実行時間バッジをこのコメントの横に表示する */
  workflowRunCommentId?: string | null;
  onApprove?: (text?: string) => Promise<void> | void;
  onReject?: (reason: string) => Promise<void> | void;
  onWithdraw?: () => Promise<void> | void;
  /** フォールバック通知（行き詰まり・エラー終了）に対する「続きを実装・調査を依頼」ボタン押下時の処理 */
  onRequestContinuation?: () => Promise<void> | void;
  /** PRマージ待ち画面（mergeApprovalPending）で「修正を依頼する」ボタン押下時の処理 */
  onRequestPrFix?: (reason: string) => Promise<void> | void;
  /** PRマージ待ち画面（mergeApprovalPending）で「マージする」ボタン押下時の処理 */
  onMergePullRequest?: () => Promise<boolean> | boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
  isRequestingContinuation?: boolean;
  isRequestingPrFix?: boolean;
  isMergingPullRequest?: boolean;
  /** PRマージ失敗時のエラーメッセージ。ボタン付近にインライン表示する */
  mergePullRequestError?: string | null;
  /** trueの場合、対応PRはマージ済みとして扱う（画面上部のマージボタンから押された場合も含む・#1288） */
  pullRequestMerged?: boolean;
  /** この欄のマージボタンからマージが成功したときに呼ばれる（画面上部のマージボタンと状態を揃えるため） */
  onPullRequestMerged?: () => void;
  /** 「ページ下部へ移動」ボタンの1回目クリック時のスクロール先とするコメントのインデックス（0始まり） */
  targetCommentIndex?: number;
  /** targetCommentIndexが指すコメントの要素に設定するref */
  targetCommentRef?: RefObject<HTMLLIElement | null>;
  /** コメントごとのAI要約の状態・生成関数。本文が長いコメントにのみ要約UIを表示する */
  commentSummary: IssueCommentSummaries;
};

/** 承認・修正カード共通のテキスト入力欄。MentionTextarea常設表示＋「音声入力を整理」ボタンを担う */
function ApprovalTextField({
  value,
  onChange,
  placeholder,
  repositoryFullName,
  issueSuggestions,
  disabled,
  onUploadingChange,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const {
    isGenerating: isCleaningUp,
    error: cleanupError,
    notConfigured: cleanupNotConfigured,
    generate: generateCleanup,
  } = useIssueBodyCleanup();

  async function handleCleanup() {
    const result = await generateCleanup(value);
    if (!result) return;
    onChange(result.text);
  }

  return (
    <div className="flex flex-col gap-2">
      <MentionTextarea
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        issueSuggestions={issueSuggestions}
        repositoryFullName={repositoryFullName}
        onUploadingChange={onUploadingChange}
        disabled={disabled}
      />
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-fit"
          disabled={!value.trim() || isCleaningUp || disabled}
          onClick={handleCleanup}
        >
          {isCleaningUp ? <Loader2 className="animate-spin" /> : <Mic />}
          音声入力を整理
        </Button>
        {cleanupNotConfigured && (
          <p className="text-xs text-muted-foreground">Claudeのトークンが設定されていません</p>
        )}
        {cleanupError && <p className="text-xs text-destructive">{cleanupError}</p>}
      </div>
    </div>
  );
}

function ApprovalActions({
  onApprove,
  onReject,
  onWithdraw,
  onRequestContinuation,
  onRequestPrFix,
  onMergePullRequest,
  isApproving,
  isRejecting,
  isWithdrawing,
  isRequestingContinuation,
  isRequestingPrFix,
  isMergingPullRequest,
  mergePullRequestError,
  pullRequestMerged,
  onPullRequestMerged,
  isFallbackNotice,
  mergeApprovalPending,
  pullRequestLink,
  pullRequestCiStatus,
  repositoryFullName,
  issueSuggestions,
  localSessionNotice,
}: {
  onApprove: (text?: string) => Promise<void> | void;
  onReject: (reason: string) => Promise<void> | void;
  onWithdraw: () => Promise<void> | void;
  onRequestContinuation?: () => Promise<void> | void;
  onRequestPrFix?: (reason: string) => Promise<void> | void;
  onMergePullRequest?: () => Promise<boolean> | boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
  isRequestingContinuation?: boolean;
  isRequestingPrFix?: boolean;
  isMergingPullRequest?: boolean;
  mergePullRequestError?: string | null;
  pullRequestMerged?: boolean;
  onPullRequestMerged?: () => void;
  isFallbackNotice?: boolean;
  mergeApprovalPending?: boolean;
  pullRequestLink?: PullRequestLink | null;
  pullRequestCiStatus?: PullRequestCiStatus | null;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  localSessionNotice?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [textValidationError, setTextValidationError] = useState<string | null>(null);
  const [isTextUploading, setIsTextUploading] = useState(false);
  const [isWithdrawConfirmOpen, setIsWithdrawConfirmOpen] = useState(false);
  const [prFixReason, setPrFixReason] = useState("");
  const [prFixValidationError, setPrFixValidationError] = useState<string | null>(null);
  const [isPrFixTextUploading, setIsPrFixTextUploading] = useState(false);
  // マージ済みかどうかは画面上部のマージボタン（#1288）と共有する。上部から押されたときは
  // 親から`pullRequestMerged`で伝わり、この欄から押したときは`onPullRequestMerged`で親へ伝える。
  // 親を持たない使い方でも表示が切り替わるよう、この欄の押下は自前の状態にも残す。
  const [isMergedHere, setIsMergedHere] = useState(false);
  const isMerged = isMergedHere || Boolean(pullRequestMerged);
  const busy = Boolean(isApproving || isRejecting || isWithdrawing || isRequestingContinuation);
  const prFixBusy = Boolean(isRequestingPrFix);
  const mergeBusy = Boolean(isMergingPullRequest);

  function changeText(value: string) {
    setText(value);
    setTextValidationError(null);
  }

  async function submitApprove() {
    const trimmed = text.trim();
    await onApprove(trimmed ? trimmed : undefined);
    setText("");
    setTextValidationError(null);
  }

  async function submitReject() {
    if (!text.trim()) {
      setTextValidationError("修正内容を入力してください");
      return;
    }
    await onReject(text);
    setText("");
    setTextValidationError(null);
  }

  async function confirmWithdraw() {
    await onWithdraw();
    setIsWithdrawConfirmOpen(false);
  }

  function changePrFixReason(value: string) {
    setPrFixReason(value);
    setPrFixValidationError(null);
  }

  async function submitPrFix() {
    if (!onRequestPrFix) return;
    if (!prFixReason.trim()) {
      setPrFixValidationError("修正内容を入力してください");
      return;
    }
    await onRequestPrFix(prFixReason);
    setPrFixReason("");
    setPrFixValidationError(null);
  }

  function handleMerged() {
    setIsMergedHere(true);
    onPullRequestMerged?.();
  }

  if (mergeApprovalPending) {
    return (
      <div className="mt-3 rounded-lg border border-dashed p-3">
        {isMerged ? (
          <>
            <p className="mb-2 text-sm font-medium">Pull Requestをマージしました</p>
            <p className="text-sm text-muted-foreground">
              画面表示が更新されるまで少しお待ちください。
            </p>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium">Pull Requestのマージが必要です</p>
            <p className="text-sm text-muted-foreground">
              GitHub上で内容を確認のうえマージしてください。
            </p>
          </>
        )}
        {pullRequestLink && (
          <GithubReferenceLink
            href={pullRequestLink.url}
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2"
          >
            対応PR #{pullRequestLink.number}
          </GithubReferenceLink>
        )}
        {onMergePullRequest && (
          <IssueMergeButton
            className="mt-2"
            onMerge={onMergePullRequest}
            onMerged={handleMerged}
            pullRequestNumber={pullRequestLink?.number ?? null}
            ciStatus={pullRequestCiStatus}
            isMerging={mergeBusy}
            isMerged={isMerged}
            showCiStatus
          />
        )}
        {onMergePullRequest && mergePullRequestError && (
          <p className="mt-1 text-sm text-destructive">{mergePullRequestError}</p>
        )}
        {onRequestPrFix && !isMerged && (
          <>
            <Separator className="my-3" />
            <div className="flex flex-col gap-2">
              <ApprovalTextField
                value={prFixReason}
                onChange={changePrFixReason}
                placeholder="修正依頼を入力（必須）"
                repositoryFullName={repositoryFullName}
                issueSuggestions={issueSuggestions}
                disabled={prFixBusy}
                onUploadingChange={setIsPrFixTextUploading}
              />
              {prFixValidationError && (
                <p className="text-sm text-destructive">{prFixValidationError}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="self-end"
                onClick={submitPrFix}
                disabled={prFixBusy || isPrFixTextUploading}
              >
                <Pencil />
                修正を依頼する
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-dashed p-3">
      <p className="mb-2 text-sm font-medium">ユーザーの承認が必要です</p>
      {/* サブPCで走っているIssueでは、承認コメントを投稿しても`11.local`により無人実行が
          反応しない（#1264）。押しても何も起きないことを、押す前に出す */}
      {localSessionNotice}
      {isFallbackNotice ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={() => onRequestContinuation?.()} disabled={busy}>
            <RotateCw />
            続きを実装・調査を依頼
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsWithdrawConfirmOpen(true)}
            disabled={busy}
          >
            <Ban />
            取り下げ
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ApprovalTextField
            value={text}
            onChange={changeText}
            placeholder="コメントを入力（承認は任意、修正は入力必須）"
            repositoryFullName={repositoryFullName}
            issueSuggestions={issueSuggestions}
            disabled={busy}
            onUploadingChange={setIsTextUploading}
          />
          {textValidationError && <p className="text-sm text-destructive">{textValidationError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={submitApprove} disabled={busy || isTextUploading}>
              <Check />
              承認
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={submitReject}
              disabled={busy || isTextUploading}
            >
              <X />
              修正
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsWithdrawConfirmOpen(true)}
              disabled={busy}
            >
              <Ban />
              取り下げ
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={isWithdrawConfirmOpen} onOpenChange={setIsWithdrawConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issueを取り下げますか？</AlertDialogTitle>
            <AlertDialogDescription>
              計画外としてIssueをクローズします。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={confirmWithdraw} disabled={busy}>
              取り下げる
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CommentThread({
  comments,
  isLoading,
  error,
  currentUserLogin,
  repositoryFullName,
  issueSuggestions,
  onUpdate,
  onDelete,
  isUpdating,
  approvalPending,
  localSessionNotice,
  mergeApprovalPending,
  pullRequestLink,
  pullRequestCiStatus,
  workflowRun,
  workflowRunCommentId,
  onApprove,
  onReject,
  onWithdraw,
  onRequestContinuation,
  onRequestPrFix,
  onMergePullRequest,
  isApproving,
  isRejecting,
  isWithdrawing,
  isRequestingContinuation,
  isRequestingPrFix,
  isMergingPullRequest,
  mergePullRequestError,
  pullRequestMerged,
  onPullRequestMerged,
  targetCommentIndex,
  targetCommentRef,
  commentSummary,
}: CommentThreadProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1].map((i) => (
          <div key={i} className={cn("flex gap-2", i === 1 && "flex-row-reverse")}>
            <Skeleton className="mt-0.5 size-7 shrink-0 rounded-full" />
            <Skeleton className="h-16 max-w-[92%] flex-1 rounded-lg md:max-w-[85%]" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">コメントの取得に失敗しました: {error}</p>;
  }

  if (comments.length === 0) {
    return (
      <>
        <p className="text-sm text-muted-foreground">まだコメントはありません</p>
        {approvalPending && onApprove && onReject && onWithdraw && (
          <ApprovalActions
            localSessionNotice={localSessionNotice}
          onApprove={onApprove}
            onReject={onReject}
            onWithdraw={onWithdraw}
            onRequestPrFix={onRequestPrFix}
            onMergePullRequest={onMergePullRequest}
            isApproving={isApproving}
            isRejecting={isRejecting}
            isWithdrawing={isWithdrawing}
            isRequestingPrFix={isRequestingPrFix}
            isMergingPullRequest={isMergingPullRequest}
            mergePullRequestError={mergePullRequestError}
            pullRequestMerged={pullRequestMerged}
            onPullRequestMerged={onPullRequestMerged}
            mergeApprovalPending={mergeApprovalPending}
            pullRequestLink={pullRequestLink}
            pullRequestCiStatus={pullRequestCiStatus}
            repositoryFullName={repositoryFullName}
            issueSuggestions={issueSuggestions}
          />
        )}
      </>
    );
  }

  const lastBotCommentIndex = comments.reduce(
    (foundIndex, comment, index) => (isBotComment(comment.author.login) ? index : foundIndex),
    -1,
  );
  const isFallbackNotice = isFallbackNoticeComment(comments[comments.length - 1]);

  function startEdit(comment: IssueComment) {
    setEditingId(comment.id);
    setEditBody(comment.body);
    setIsImageUploading(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
    setIsImageUploading(false);
  }

  async function saveEdit(commentId: string) {
    const ok = await onUpdate(commentId, editBody);
    if (ok) {
      setEditingId(null);
      setEditBody("");
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    const ok = await onDelete(deletingId);
    if (ok) setDeletingId(null);
  }

  return (
    <>
      <ul className="flex flex-col gap-4">
        {comments.map((comment, index) => {
          const isQuestion = isAskClaudeQuestionComment(comment);
          const isAnswer = isQaAnswerComment(comment);
          const source = resolveCommentSource(comment, comment.author.login);
          const role = source ? commentAgentRole(source) : null;
          const profile = role ? COMMENT_AGENT_PROFILES[role] : null;
          // ローカル（サブPC）セッションのコメントはユーザー本人のlogin名で投稿されるため、
          // login名の一致だけで自分の発言と判定すると実装ボットの報告が右寄せになる（#1346）。
          // 本文のマーカーで自動投稿と断定できるものは、自分の名義でもボットとして左に出す。
          const isSelf =
            currentUserLogin != null &&
            comment.author.login === currentUserLogin &&
            !isMarkedAutomationComment(source);
          const headerName = isSelf || !profile ? comment.author.login : profile.label;
          const timeLabel = (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
              {comment.createdAtLabel}
            </span>
          );
          return (
            <li
              key={comment.id}
              ref={index === targetCommentIndex ? targetCommentRef : undefined}
              className="flex flex-col gap-2"
            >
              <div className={cn("flex gap-2", isSelf && "flex-row-reverse")}>
                <UserAvatar
                  login={comment.author.login}
                  agent={isSelf ? null : role}
                  className="mt-0.5 size-7 shrink-0"
                />
                <div
                  className={cn(
                    "min-w-0 rounded-lg border p-3",
                    editingId === comment.id || !isSelf ? "flex-1" : null,
                    "max-w-[92%] md:max-w-[85%]",
                    isSelf ? "rounded-tr-none" : "rounded-tl-none",
                    isSelf && "border-primary/20 bg-primary/5",
                    !isSelf && isQuestion && "border-blue-500/40 bg-blue-500/5",
                    !isSelf && !isQuestion && isAnswer && "border-violet-500/40 bg-violet-500/5",
                    !isSelf && !isQuestion && !isAnswer && profile?.bubbleClassName,
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className={cn("font-medium", !isSelf && profile?.textClassName)}>
                        {headerName}
                      </span>
                      {workflowRunCommentId === comment.id && (
                        <WorkflowRunStatus run={workflowRun ?? null} />
                      )}
                      {isQuestion && (
                        <Badge
                          variant="outline"
                          className="border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                        >
                          質問
                        </Badge>
                      )}
                      {isAnswer && (
                        <Badge
                          variant="outline"
                          className="border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400"
                        >
                          回答
                        </Badge>
                      )}
                      {timeLabel}
                    </div>
                    {isBotComment(comment.author.login) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="コメントの操作メニュー"
                            className="relative after:absolute after:-inset-3.5 md:after:-inset-1"
                          >
                            <MoreHorizontal className="size-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => startEdit(comment)}>
                            <Pencil />
                            編集
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeletingId(comment.id)}
                          >
                            <Trash2 />
                            削除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {editingId === comment.id ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <MentionTextarea
                        className="min-h-20"
                        value={editBody}
                        onChange={setEditBody}
                        issueSuggestions={issueSuggestions}
                        disabled={isUpdating}
                        onUploadingChange={setIsImageUploading}
                        repositoryFullName={repositoryFullName}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editBody.trim()) {
                            e.preventDefault();
                            saveEdit(comment.id);
                          }
                        }}
                        autoFocus
                      />
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={cancelEdit} disabled={isUpdating}>
                          キャンセル
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => saveEdit(comment.id)}
                          disabled={!editBody.trim() || isUpdating || isImageUploading}
                        >
                          {isUpdating && <Loader2 className="animate-spin" />}
                          {isUpdating ? "保存中..." : "保存"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* 長文コメントは要約を先に読めるよう、本文より前に表示する（#631）。 */}
                      {comment.body.length > LONG_COMMENT_THRESHOLD && (
                        <CommentAiSummary
                          body={comment.body}
                          summary={commentSummary.summaries[comment.id]?.summary ?? null}
                          isGenerating={commentSummary.generatingIds.has(comment.id)}
                          error={commentSummary.errors[comment.id] ?? null}
                          notConfigured={commentSummary.notConfigured}
                          onGenerate={() => commentSummary.generate(comment.id)}
                        />
                      )}
                      <MarkdownBody
                        content={comment.body}
                        className="mt-1 text-xs leading-relaxed"
                        repositoryFullName={repositoryFullName}
                      />
                      {comment.reactionCount > 0 && (
                        <span className="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                          <ThumbsUp className="size-3" />
                          {comment.reactionCount}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              {approvalPending && onApprove && onReject && onWithdraw && lastBotCommentIndex === index && (
                <ApprovalActions
                  localSessionNotice={localSessionNotice}
          onApprove={onApprove}
                  onReject={onReject}
                  onWithdraw={onWithdraw}
                  onRequestContinuation={onRequestContinuation}
                  onRequestPrFix={onRequestPrFix}
                  onMergePullRequest={onMergePullRequest}
                  isApproving={isApproving}
                  isRejecting={isRejecting}
                  isWithdrawing={isWithdrawing}
                  isRequestingContinuation={isRequestingContinuation}
                  isRequestingPrFix={isRequestingPrFix}
                  isMergingPullRequest={isMergingPullRequest}
                  mergePullRequestError={mergePullRequestError}
                  pullRequestMerged={pullRequestMerged}
                  onPullRequestMerged={onPullRequestMerged}
                  isFallbackNotice={isFallbackNotice}
                  mergeApprovalPending={mergeApprovalPending}
                  pullRequestLink={pullRequestLink}
                  pullRequestCiStatus={pullRequestCiStatus}
                  repositoryFullName={repositoryFullName}
                  issueSuggestions={issueSuggestions}
                />
              )}
            </li>
          );
        })}
      </ul>
      {approvalPending && onApprove && onReject && onWithdraw && lastBotCommentIndex === -1 && (
        <ApprovalActions
          localSessionNotice={localSessionNotice}
          onApprove={onApprove}
          onReject={onReject}
          onWithdraw={onWithdraw}
          onRequestContinuation={onRequestContinuation}
          onRequestPrFix={onRequestPrFix}
          onMergePullRequest={onMergePullRequest}
          isApproving={isApproving}
          isRejecting={isRejecting}
          isWithdrawing={isWithdrawing}
          isRequestingContinuation={isRequestingContinuation}
          isRequestingPrFix={isRequestingPrFix}
          isMergingPullRequest={isMergingPullRequest}
          mergePullRequestError={mergePullRequestError}
          pullRequestMerged={pullRequestMerged}
          onPullRequestMerged={onPullRequestMerged}
          isFallbackNotice={isFallbackNotice}
          mergeApprovalPending={mergeApprovalPending}
          pullRequestLink={pullRequestLink}
          pullRequestCiStatus={pullRequestCiStatus}
          repositoryFullName={repositoryFullName}
          issueSuggestions={issueSuggestions}
        />
      )}

      <AlertDialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>コメントを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>この操作は取り消せません。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
