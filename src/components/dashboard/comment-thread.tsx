"use client";

import { useState } from "react";

import { Ban, Check, Loader2, MoreHorizontal, Pencil, ThumbsUp, Trash2, X } from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MentionTextarea, type IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { UserAvatar } from "@/components/dashboard/user-avatar";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { isBotComment } from "@/lib/github/is-bot-comment";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssueComment } from "@/types/issue";

type CommentThreadProps = {
  comments: IssueComment[];
  isLoading?: boolean;
  error?: string | null;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  onUpdate: (commentId: string, body: string) => Promise<boolean>;
  onDelete: (commentId: string) => Promise<boolean>;
  /** trueの場合、コメントの編集保存中であることを示す（保存ボタン・テキスト欄を無効化する） */
  isUpdating?: boolean;
  /** trueの場合、直近のbotコメントの下に承認・修正・取り下げボタン（またはPRマージ案内）を表示する（00.check-userラベルが付いているissue用） */
  approvalPending?: boolean;
  /** trueの場合、承認・修正・取り下げボタンの代わりにPRマージを促す案内を表示する（PRマージ待ちで00.check-userが付いているissue用） */
  mergeApprovalPending?: boolean;
  /** mergeApprovalPending時に案内とあわせて表示する対応PRへのリンク。取得できない場合はnull */
  pullRequestLink?: PullRequestLink | null;
  onApprove?: () => Promise<void> | void;
  onReject?: (reason: string) => Promise<void> | void;
  onWithdraw?: () => Promise<void> | void;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
};

function ApprovalActions({
  onApprove,
  onReject,
  onWithdraw,
  isApproving,
  isRejecting,
  isWithdrawing,
  mergeApprovalPending,
  pullRequestLink,
}: {
  onApprove: () => Promise<void> | void;
  onReject: (reason: string) => Promise<void> | void;
  onWithdraw: () => Promise<void> | void;
  isApproving?: boolean;
  isRejecting?: boolean;
  isWithdrawing?: boolean;
  mergeApprovalPending?: boolean;
  pullRequestLink?: PullRequestLink | null;
}) {
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [isWithdrawConfirmOpen, setIsWithdrawConfirmOpen] = useState(false);
  const busy = Boolean(isApproving || isRejecting || isWithdrawing);

  async function submitReject() {
    await onReject(rejectReason);
    setIsRejectOpen(false);
    setRejectReason("");
  }

  async function confirmWithdraw() {
    await onWithdraw();
    setIsWithdrawConfirmOpen(false);
  }

  if (mergeApprovalPending) {
    return (
      <div className="mt-3 rounded-lg border border-dashed p-3">
        <p className="mb-2 text-sm font-medium">Pull Requestのマージが必要です</p>
        <p className="text-sm text-muted-foreground">
          GitHub上で内容を確認のうえマージしてください。
        </p>
        {pullRequestLink && (
          <a
            href={pullRequestLink.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2"
          >
            対応PR #{pullRequestLink.number}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-dashed p-3">
      <p className="mb-2 text-sm font-medium">ユーザーの承認が必要です</p>
      {isRejectOpen ? (
        <div className="flex flex-col gap-2">
          <Textarea
            placeholder="修正依頼を入力（任意）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
                e.preventDefault();
                submitReject();
              }
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsRejectOpen(false)} disabled={busy}>
              キャンセル
            </Button>
            <Button variant="destructive" size="sm" onClick={submitReject} disabled={busy}>
              修正を送信
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onApprove()} disabled={busy}>
            <Check />
            承認
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIsRejectOpen(true)} disabled={busy}>
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
  repositoryFullName,
  issueSuggestions,
  onUpdate,
  onDelete,
  isUpdating,
  approvalPending,
  mergeApprovalPending,
  pullRequestLink,
  onApprove,
  onReject,
  onWithdraw,
  isApproving,
  isRejecting,
  isWithdrawing,
}: CommentThreadProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-2">
            <Skeleton className="mt-0.5 size-7 shrink-0 rounded-full" />
            <Skeleton className="h-16 flex-1 rounded-lg" />
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
            onApprove={onApprove}
            onReject={onReject}
            onWithdraw={onWithdraw}
            isApproving={isApproving}
            isRejecting={isRejecting}
            isWithdrawing={isWithdrawing}
            mergeApprovalPending={mergeApprovalPending}
            pullRequestLink={pullRequestLink}
          />
        )}
      </>
    );
  }

  const lastBotCommentIndex = comments.reduce(
    (foundIndex, comment, index) => (isBotComment(comment.author.login) ? index : foundIndex),
    -1,
  );

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
        {comments.map((comment, index) => (
          <li key={comment.id} className="flex gap-2">
            <UserAvatar login={comment.author.login} className="mt-0.5 size-7 shrink-0" />
            <div className="min-w-0 flex-1 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{comment.author.login}</span>
                  <span className="text-xs text-muted-foreground">{comment.createdAtLabel}</span>
                </div>
                {isBotComment(comment.author.login) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label="コメントの操作メニュー">
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
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editBody.trim()) {
                        e.preventDefault();
                        saveEdit(comment.id);
                      }
                    }}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
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
                  <MarkdownBody
                    content={comment.body}
                    className="mt-1"
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
              {approvalPending && onApprove && onReject && onWithdraw && lastBotCommentIndex === index && (
                <ApprovalActions
                  onApprove={onApprove}
                  onReject={onReject}
                  onWithdraw={onWithdraw}
                  isApproving={isApproving}
                  isRejecting={isRejecting}
                  isWithdrawing={isWithdrawing}
                  mergeApprovalPending={mergeApprovalPending}
                  pullRequestLink={pullRequestLink}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {approvalPending && onApprove && onReject && onWithdraw && lastBotCommentIndex === -1 && (
        <ApprovalActions
          onApprove={onApprove}
          onReject={onReject}
          onWithdraw={onWithdraw}
          isApproving={isApproving}
          isRejecting={isRejecting}
          isWithdrawing={isWithdrawing}
          mergeApprovalPending={mergeApprovalPending}
          pullRequestLink={pullRequestLink}
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
