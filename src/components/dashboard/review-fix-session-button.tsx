"use client";

import { useState } from "react";
import { SquareTerminal } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
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
  buildReviewFixRequestText,
  describeReviewFixSessionRoute,
  REVIEW_FIX_NOTE_MAX_LENGTH,
  REVIEW_FIX_SESSION_INSTRUCTION,
  reviewFixSessionActionLabel,
} from "@/lib/dispatch/review-fix-session";
import { cn } from "@/lib/utils";
import type { ReviewFixSessionRoute } from "@/types/pull-request";

/**
 * 「Issueのセッションで直す」（#5493）。PRのレビュー指摘を元Issueのセッションへ渡す。
 *
 * 押すと確認ダイアログを開き、**送り先・Issueへ投稿する依頼の全文・セッションへ送る1行を
 * 押す前に全部見せる**（`docs/multi-agent/gates.md`の「押す前に全文が画面に出る」）。
 * 任意の方針メモは依頼コメントの末尾に入るだけで、セッションへ流れる1行は変わらない。
 * 文面はサーバーと同じ`buildReviewFixRequestText`で作るが、指摘の要点はサーバーがPRを
 * 読み直して作るため、画面の表示と細部が違うことはある。
 */
export function ReviewFixSessionButton({
  repositoryFullName,
  pullRequestNumber,
  headSha,
  headRef,
  issueNumber,
  route,
  verdictLabel,
  concerns,
  reviewUrl,
  label,
  variant = "outline",
  className,
  onRequested,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  headRef: string;
  issueNumber: number;
  route: ReviewFixSessionRoute;
  /** 「要修正」「要確認」 */
  verdictLabel: string;
  concerns: string[];
  reviewUrl: string | null;
  /** 既定は「Issue #N のセッションで直す」 */
  label?: string;
  variant?: "default" | "outline";
  className?: string;
  /** 依頼できたあと（PR詳細・Issue詳細の取り直し） */
  onRequested?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const preview = buildReviewFixRequestText({
    pullRequestNumber,
    headSha,
    headRef,
    verdictLabel,
    reviewUrl,
    concerns,
    note,
  });

  async function submit() {
    const [owner, repo] = repositoryFullName.split("/");
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/pull-requests/review-fix-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: pullRequestNumber, note: note.trim() || undefined }),
      });
      if (!response.ok) {
        const payload: { message?: string; error?: string } = await response.json().catch(() => ({}));
        setError(payload.message ?? payload.error ?? "依頼できませんでした");
        // 依頼コメントが残って「中断」になった場合もあるので、失敗でも取り直す
        onRequested?.();
        return;
      }
      setOpen(false);
      setNote("");
      setDone(true);
      onRequested?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "依頼できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className={cn("h-9 text-xs", className)}
        disabled={done}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <SquareTerminal className="size-3.5" />
        {done ? "依頼しました" : (label ?? `Issue #${issueNumber} のセッションで直す`)}
      </Button>
      {error && !open && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
      <AlertDialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Issue #{issueNumber} のセッションで直しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              指摘をIssueコメントにまとめ、元のIssueのセッションへ渡します。新しいIssue・PRは作らず、同じブランチ（{headRef}）・同じPRを直してpushします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">対象PR</dt>
            <dd>
              #{pullRequestNumber}（HEAD {headSha.slice(0, 7)}・自動レビュー「{verdictLabel}」）
            </dd>
            <dt className="text-muted-foreground">送り先</dt>
            <dd>{describeReviewFixSessionRoute(route)}</dd>
          </dl>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-semibold">Issue #{issueNumber} へ投稿する修正依頼</p>
            <pre className="max-h-56 overflow-y-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
              {preview}
            </pre>
          </div>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold">方針メモ（任意・上の依頼の末尾に足します）</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={REVIEW_FIX_NOTE_MAX_LENGTH}
              rows={2}
              placeholder="例: 送信前の存在確認は不要。セッション名の取り違えだけ直す"
              className="w-full rounded-md border bg-background p-2 text-xs"
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-semibold">セッションへ送る1行（固定）</p>
            {route.kind === "session" ? (
              <pre className="rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
                {REVIEW_FIX_SESSION_INSTRUCTION}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                送りません。起動したセッションが最初にIssueのコメントを読むため、上の依頼がそのまま伝わります。
              </p>
            )}
            {route.kind === "session" && (
              <p className="text-xs text-muted-foreground">
                承認待ちや選択肢の表示中は送らずに見送ります。届いたら、マージ待ちの確認ラベル（00.check-user）を外します。
              </p>
            )}
          </div>
          <ApiErrorMessage message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void submit();
              }}
              disabled={submitting}
            >
              {submitting ? "依頼中..." : reviewFixSessionActionLabel(route)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
