"use client";

import { type RefObject, useState, type ReactNode } from "react";

import {
  Ban,
  BellOff,
  Check,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RotateCw,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";

import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { CheckUserReasonNotice } from "@/components/dashboard/check-user-reason-notice";
import { CommentAiSummary } from "@/components/dashboard/comment-ai-summary";
import { IssuePullRequestList } from "@/components/dashboard/issue-pull-request-list";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";
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
import type { IssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import type { WorkflowRunInfo } from "@/hooks/use-issue-workflow-run";
import { checkUserTargetProps } from "@/lib/check-user-focus";
import type { CheckUserReason } from "@/lib/github/approval-labels";
import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";
import { isAskClaudeQuestionComment, isQaAnswerComment } from "@/lib/github/ask-claude";
import {
  COMMENT_AGENT_PROFILES,
  commentAgentRole,
  isMarkedAutomationComment,
  resolveCommentSource,
} from "@/lib/github/comment-source";
import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import { isBotComment } from "@/lib/github/is-bot-comment";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import type { MergeCheckReasons } from "@/lib/merge-check-reasons";
import { cn } from "@/lib/utils";
import type { IssueComment } from "@/types/issue";
import type { IssuePullRequest } from "@/types/pull-request";

/** この文字数を超えるコメント本文にのみAI要約の生成ボタンを表示する */
const LONG_COMMENT_THRESHOLD = 400;

/** マージ済みのPRがまだ無いときに使う空集合。毎レンダーの再生成を避ける */
const EMPTY_MERGED_NUMBERS: ReadonlySet<number> = new Set();

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
  /** サブPC実行中に承認が空振りすることを伝える案内（#1264・#1417） */
  localSessionNotice?: ReactNode;
  /**
   * 計画の承認待ちのときに出す「計画をレビュー」（G1・#1855）。**承認カードの中に置く。**
   * 承認するかどうかを決める瞬間に押すもので、押すと指摘がこのIssueのコメントとして返る。
   * 対象外（理由が計画でない・実行できるホストがない）のときは親がundefinedを渡す。
   */
  planReviewAction?: ReactNode;
  /**
   * trueの場合、承認・修正・取り下げボタンを出さずlocalSessionNoticeだけを表示する（#1417）。
   * 走っているローカルセッションが入力待ちで、どのボタンも効かない状態を表す。
   */
  sessionWaitingInput?: boolean;
  /**
   * そのIssueをローカルセッションが担当しているか（#1903）。trueのとき、承認欄のボタンを
   * 「コメント」「質問する」「確認待ちを外す」「取り下げ」へ差し替える。
   */
  localSession?: boolean;
  /** そのセッションが生きているか。案内の言い方（届かない／終了している）を決める */
  sessionAlive?: boolean;
  /** 「質問する」を出してよいか（`canAskClaude`の結果）。openなIssueなら常にtrue */
  canAskClaude?: boolean;
  /**
   * セッションの状態（`/api/dispatch`）がまだ届いていない（#1810）。**`sessionWaitingInput`が
   * 未確定**であることを表し、trueの間は承認カードを描かない。取得前は必ず
   * `sessionWaitingInput === false`になるため、そのまま描くと承認・修正ボタンを一瞬出してから
   * Remote Controlの案内へ差し替わる。
   */
  sessionStatePending?: boolean;
  /** trueの場合、承認・修正・取り下げボタンの代わりにPRマージを促す案内を表示する（PRマージ待ちで00.check-userが付いているissue用） */
  mergeApprovalPending?: boolean;
  /** 自動マージされなかった理由（#1631）。PRマージ待ちの案内へ添える。解決は親が行う */
  mergeCheckReasons?: MergeCheckReasons | null;
  /** `00.check-user`が付いている理由（#1490）。承認カードの見出しを出し分ける。読めない場合はnull */
  checkUserReason?: CheckUserReason | null;
  /** mergeApprovalPending時に案内とあわせて表示する対応PRへのリンク（#1339で複数対応） */
  pullRequestLinks?: PullRequestLink[];
  /** 対応PRのタイトル・状態・CI状態。取得前は空配列 */
  pullRequests?: IssuePullRequest[];
  /** 直近の「実行ログ:」リンクが指すGitHub Actions実行の状態。取得できない場合はnull */
  workflowRun?: WorkflowRunInfo | null;
  /** workflowRunに対応する「実行ログ:」リンクを含むコメントのID。実行時間バッジをこのコメントの横に表示する */
  workflowRunCommentId?: string | null;
  onApprove?: (text?: string) => Promise<void> | void;
  onReject?: (reason: string) => Promise<void> | void;
  onWithdraw?: () => Promise<void> | void;
  /** ローカルセッション担当中の承認欄で「コメント」を押したときの処理（#1903。ラベルは変えない） */
  onComment?: (body: string) => Promise<void> | void;
  /** 同じく「質問する」（読み取り専用の質問応答。`11.local`が付いていても唯一起動できる経路） */
  onAskClaude?: (question: string) => Promise<void> | void;
  /** 同じく「確認待ちを外す」（`00.check-user`と理由ラベルを外し、記録のコメントを残す） */
  onDismissCheckUser?: (text?: string) => Promise<void> | void;
  /** フォールバック通知（行き詰まり・エラー終了）に対する「続きを実装・調査を依頼」ボタン押下時の処理 */
  onRequestContinuation?: () => Promise<void> | void;
  /** PRマージ待ち画面（mergeApprovalPending）で「修正を依頼する」ボタン押下時の処理 */
  onRequestPrFix?: (reason: string) => Promise<void> | void;
  /** PRマージ待ち画面（mergeApprovalPending）で「マージする」ボタン押下時の処理 */
  onMergePullRequest?: (pullRequestNumber: number) => Promise<boolean> | boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
  isRequestingContinuation?: boolean;
  isRequestingPrFix?: boolean;
  isMergingPullRequest?: boolean;
  /** PRマージ失敗時のエラーメッセージ。ボタン付近にインライン表示する */
  mergePullRequestError?: string | null;
  /** 直近にマージを実行したPR番号。実行中の表示とエラーの表示先を決める */
  mergeTargetNumber?: number | null;
  /** マージ済みとして扱うPR番号（本文の上のマージボタンから押された場合も含む・#1288/#1339） */
  mergedPullRequestNumbers?: ReadonlySet<number>;
  /** この欄のマージボタンからマージが成功したときに呼ばれる（本文の上の一覧と状態を揃えるため） */
  onPullRequestMerged?: (pullRequestNumber: number) => void;
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
      <BodyCleanupButton value={value} onCleaned={onChange} disabled={disabled} />
    </div>
  );
}

function ApprovalActions({
  onApprove,
  onReject,
  onWithdraw,
  onComment,
  onAskClaude,
  onDismissCheckUser,
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
  mergeTargetNumber,
  mergedPullRequestNumbers,
  onPullRequestMerged,
  isFallbackNotice,
  mergeApprovalPending,
  mergeCheckReasons = null,
  checkUserReason = null,
  sessionWaitingInput,
  sessionStatePending = false,
  localSession = false,
  sessionAlive = false,
  canAskClaude = false,
  pullRequestLinks,
  pullRequests,
  repositoryFullName,
  issueSuggestions,
  localSessionNotice,
  planReviewAction,
}: {
  onApprove: (text?: string) => Promise<void> | void;
  onReject: (reason: string) => Promise<void> | void;
  onWithdraw: () => Promise<void> | void;
  onComment?: (body: string) => Promise<void> | void;
  onAskClaude?: (question: string) => Promise<void> | void;
  onDismissCheckUser?: (text?: string) => Promise<void> | void;
  onRequestContinuation?: () => Promise<void> | void;
  onRequestPrFix?: (reason: string) => Promise<void> | void;
  onMergePullRequest?: (pullRequestNumber: number) => Promise<boolean> | boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
  isRequestingContinuation?: boolean;
  isRequestingPrFix?: boolean;
  isMergingPullRequest?: boolean;
  mergePullRequestError?: string | null;
  mergeTargetNumber?: number | null;
  mergedPullRequestNumbers?: ReadonlySet<number>;
  onPullRequestMerged?: (pullRequestNumber: number) => void;
  isFallbackNotice?: boolean;
  mergeApprovalPending?: boolean;
  /**
   * 自動マージされなかった理由（#1631）。`mergeApprovalPending`のときだけ描く。
   * 解決は親（Issue詳細）が`resolveMergeCheckReasons`で行い、画面上部の対応PRセクションと
   * **同じ値**を渡す。ここで解決し直すと、上と下で違う理由が出うる
   */
  mergeCheckReasons?: MergeCheckReasons | null;
  /** `00.check-user`が付いている理由（#1490）。読めないリポジトリではnull */
  checkUserReason?: CheckUserReason | null;
  sessionWaitingInput?: boolean;
  /** セッションの状態がまだ届いていない（#1810）。`sessionWaitingInput`が未確定であることを表す */
  sessionStatePending?: boolean;
  /** ローカルセッションが担当しているIssueか（#1903）。ボタンの構成を差し替える */
  localSession?: boolean;
  /** そのセッションが生きているか（#1903）。案内の言い方を決める */
  sessionAlive?: boolean;
  /** 「質問する」を出してよいか（#1903） */
  canAskClaude?: boolean;
  pullRequestLinks?: PullRequestLink[];
  pullRequests?: IssuePullRequest[];
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  localSessionNotice?: ReactNode;
  planReviewAction?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [textValidationError, setTextValidationError] = useState<string | null>(null);
  const [isTextUploading, setIsTextUploading] = useState(false);
  const [isWithdrawConfirmOpen, setIsWithdrawConfirmOpen] = useState(false);
  const [prFixReason, setPrFixReason] = useState("");
  const [prFixValidationError, setPrFixValidationError] = useState<string | null>(null);
  const [isPrFixTextUploading, setIsPrFixTextUploading] = useState(false);
  // マージ済みかどうかは本文の上の対応PR一覧（#1288・#1339）と共有する。上の一覧から
  // 押されたときは親から`mergedPullRequestNumbers`で伝わり、この欄から押したときは
  // `onPullRequestMerged`で親へ伝える。親を持たない使い方でも表示が切り替わるよう、
  // この欄の押下は自前の状態にも残す。
  const [mergedHere, setMergedHere] = useState<ReadonlySet<number>>(EMPTY_MERGED_NUMBERS);
  const mergedNumbers = new Set([...mergedHere, ...(mergedPullRequestNumbers ?? [])]);
  const isMerged =
    mergedNumbers.size > 0 &&
    (pullRequestLinks ?? []).every((link) => mergedNumbers.has(link.number));
  const busy = Boolean(isApproving || isRejecting || isWithdrawing || isRequestingContinuation);
  const prFixBusy = Boolean(isRequestingPrFix);

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

  /**
   * ローカルセッション担当中の承認欄（#1903）。押しても走っているセッションには届かないため、
   * ここでできるのは「記録を残す」「質問する」「確認待ちの印を片付ける」の3つだけ。
   */
  async function submitLocalComment() {
    if (!onComment) return;
    if (!text.trim()) {
      setTextValidationError("コメントを入力してください");
      return;
    }
    await onComment(text);
    setText("");
    setTextValidationError(null);
  }

  async function submitLocalQuestion() {
    if (!onAskClaude) return;
    if (!text.trim()) {
      setTextValidationError("質問を入力してください");
      return;
    }
    await onAskClaude(text);
    setText("");
    setTextValidationError(null);
  }

  async function submitDismissCheckUser() {
    if (!onDismissCheckUser) return;
    const trimmed = text.trim();
    await onDismissCheckUser(trimmed ? trimmed : undefined);
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

  function handleMerged(pullRequestNumber: number) {
    setMergedHere((prev) => new Set([...prev, pullRequestNumber]));
    onPullRequestMerged?.(pullRequestNumber);
  }

  // セッションの状態が届くまでは、承認カードをどちらの形にも決めない（#1810）。取得前は
  // `sessionWaitingInput`が必ずfalseになるため、そのまま描くと「承認」「修正」を一瞬出して
  // からRemote Controlの案内（下の分岐）へ差し替わる。**マージ待ちだけは別**で、判定材料が
  // ラベルとコメントなのでセッションの状態を待つ理由が無い
  if (sessionStatePending && !mergeApprovalPending) return null;

  // 次にどこの何を押せばよいか（#1663）。承認カードは行き先そのものなので、移動ボタンは
  // 出さずボタン名だけが入る（`placement: "approval"`）。理由ラベルが読めなければnullで、
  // 従来どおり見出しだけになる
  // ローカル担当中は「内容がエージェントへ渡ります」と言わせない（#1903）。Remote Controlを
  // 開くボタンは案内（`localSessionNotice`）が持つので、URLはここへ渡さない
  const guidance = resolveCheckUserGuidance({
    reason: checkUserReason,
    placement: "approval",
    localSession,
    sessionAlive,
  });

  // 走っているセッションが入力待ちのときは、承認・修正・取り下げのどれも効かない（#1417）。
  // **PRマージ待ちを優先するのは、あちらはGitHub側の操作で`11.local`中でも実際に効くため。**
  if (sessionWaitingInput && !mergeApprovalPending) {
    return (
      <div {...checkUserTargetProps("approval")} className="mt-3 rounded-lg border border-dashed p-3">
        <p className="mb-2 text-sm font-medium">セッションが入力を待っています</p>
        {localSessionNotice}
        {/* 計画の承認待ちはこちらの分岐に来ることが多い（計画を出したセッションは、承認を待つ
            プロンプトを出したまま生きている）。**押せる操作がここにしか無い**ので、
            「計画をレビュー」もここへ置く（#1855） */}
        {planReviewAction}
      </div>
    );
  }

  if (mergeApprovalPending) {
    return (
      <div {...checkUserTargetProps("approval")} className="mt-3 rounded-lg border border-dashed p-3">
        {isMerged ? (
          <>
            <p className="mb-2 text-sm font-medium">Pull Requestをマージしました</p>
            <p className="text-sm text-muted-foreground">
              画面表示が更新されるまで少しお待ちください。
            </p>
          </>
        ) : guidance?.reason === "merge" ? (
          /* 何を押せばよいか（#1663）と、なぜ自動マージされなかったのか（#1631）を1つの枠に
             まとめる。理由の詳細は行き先の案内より下に置く */
          <CheckUserReasonNotice guidance={guidance} className="mb-2">
            {mergeCheckReasons && (
              <MergeCheckReasonNotice reasons={mergeCheckReasons} className="bg-background" />
            )}
          </CheckUserReasonNotice>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium">Pull Requestのマージが必要です</p>
            <p className="text-sm text-muted-foreground">
              GitHub上で内容を確認のうえマージしてください。
            </p>
            {/* なぜ自動マージされなかったのかを、押す前に読める位置へ出す（#1631）。
                画面上部の対応PRセクションと同じ内容・同じ体裁 */}
            {mergeCheckReasons && (
              <MergeCheckReasonNotice reasons={mergeCheckReasons} className="mt-2" />
            )}
          </>
        )}
        {/* 対応PRとマージボタンは、本文の上に出しているのと同じ一覧で出す（#1339）。
            マージはPR単位の操作なので、どのPRをマージするのかを行として示す */}
        <IssuePullRequestList
          variant="plain"
          className="mt-2"
          links={pullRequestLinks ?? []}
          pullRequests={pullRequests ?? []}
          mergeApprovalPending
          onMerge={onMergePullRequest}
          onMerged={handleMerged}
          mergedNumbers={mergedNumbers}
          mergeTargetNumber={mergeTargetNumber}
          isMerging={isMergingPullRequest}
          mergeError={mergePullRequestError}
        />
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
    <div {...checkUserTargetProps("approval")} className="mt-3 rounded-lg border border-dashed p-3">
      {/* 理由が読めるなら、押すボタンの案内まで含めて出す（#1663）。読めないリポジトリでは
          行き先を決められないため、従来どおり見出しだけにする */}
      {guidance ? (
        <CheckUserReasonNotice guidance={guidance} className="mb-2" />
      ) : (
        <p className="mb-2 text-sm font-medium">ユーザーの承認が必要です</p>
      )}
      {/* サブPCで走っているIssueでは、承認コメントを投稿しても`11.local`により無人実行が
          反応しない（#1264）。押しても何も起きないことを、押す前に出す */}
      {localSessionNotice}
      {/* 承認するかどうかを決める場所で、計画レビューを起こせるようにする（#1855） */}
      {planReviewAction}
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
      ) : localSession ? (
        /* ローカルセッションが担当しているIssue（#1903）。「承認」「修正」は押しても
           セッションへ届かず、`@claude`コメントが無人実行を起こして「`11.local`が付いて
           いるため対応しません」という案内だけを足していた。ここでできることの名前に
           そのまま置き換える。塗りつぶしは案内の中のRemote Controlだけが持つ */
        <div className="flex flex-col gap-2">
          <ApprovalTextField
            value={text}
            onChange={changeText}
            placeholder="コメントを入力（記録として残ります。セッションには届きません）"
            repositoryFullName={repositoryFullName}
            issueSuggestions={issueSuggestions}
            disabled={busy}
            onUploadingChange={setIsTextUploading}
          />
          {textValidationError && <p className="text-sm text-destructive">{textValidationError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {onComment && (
              <Button
                variant="outline"
                size="sm"
                onClick={submitLocalComment}
                disabled={busy || isTextUploading || !text.trim()}
              >
                <MessageSquare />
                コメント
              </Button>
            )}
            {onAskClaude && canAskClaude && (
              <Button
                variant="outline"
                size="sm"
                onClick={submitLocalQuestion}
                disabled={busy || isTextUploading || !text.trim()}
              >
                <MessageCircleQuestion />
                質問する
              </Button>
            )}
            {onDismissCheckUser && (
              <Button
                variant="outline"
                size="sm"
                onClick={submitDismissCheckUser}
                disabled={busy || isTextUploading}
              >
                <BellOff />
                確認待ちを外す
              </Button>
            )}
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
  checkUserReason = null,
  localSessionNotice,
  planReviewAction,
  sessionWaitingInput,
  sessionStatePending,
  localSession,
  sessionAlive,
  canAskClaude,
  mergeApprovalPending,
  mergeCheckReasons = null,
  pullRequestLinks,
  pullRequests,
  workflowRun,
  workflowRunCommentId,
  onApprove,
  onReject,
  onWithdraw,
  onComment,
  onAskClaude,
  onDismissCheckUser,
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
  mergeTargetNumber,
  mergedPullRequestNumbers,
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

  const isFallbackNotice =
    comments.length > 0 && isFallbackNoticeComment(comments[comments.length - 1]);

  // 承認・PRマージのカードは、特定のコメントに紐づく操作ではなくissueの現在の状態に対する
  // 操作なので、常にコメント一覧の末尾に出す（#1639）。以前は「最後のbotコメント」の直下に
  // 差し込んでいたが、その判定はissue-deckのGitHub Appのlogin名だけを見ており、
  // `github-actions[bot]`名義の進捗通知やローカルセッションの報告（ユーザー本人のlogin名で
  // 投稿される・#1346）が後に続くと、カードが一覧の途中に埋もれて見つけられなかった。
  const approvalActions =
    approvalPending && onApprove && onReject && onWithdraw ? (
      <ApprovalActions
        localSessionNotice={localSessionNotice}
        planReviewAction={planReviewAction}
        onApprove={onApprove}
        onReject={onReject}
        onWithdraw={onWithdraw}
        onComment={onComment}
        onAskClaude={onAskClaude}
        onDismissCheckUser={onDismissCheckUser}
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
        mergeTargetNumber={mergeTargetNumber}
        mergedPullRequestNumbers={mergedPullRequestNumbers}
        onPullRequestMerged={onPullRequestMerged}
        isFallbackNotice={isFallbackNotice}
        mergeApprovalPending={mergeApprovalPending}
        mergeCheckReasons={mergeCheckReasons}
        checkUserReason={checkUserReason}
        sessionWaitingInput={sessionWaitingInput}
        sessionStatePending={sessionStatePending}
        localSession={localSession}
        sessionAlive={sessionAlive}
        canAskClaude={canAskClaude}
        pullRequestLinks={pullRequestLinks}
        pullRequests={pullRequests}
        repositoryFullName={repositoryFullName}
        issueSuggestions={issueSuggestions}
      />
    ) : null;

  if (comments.length === 0) {
    return (
      <>
        <p className="text-sm text-muted-foreground">まだコメントはありません</p>
        {approvalActions}
      </>
    );
  }

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
            </li>
          );
        })}
      </ul>
      {approvalActions}

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
