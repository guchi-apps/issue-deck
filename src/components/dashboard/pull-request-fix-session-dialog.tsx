"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { ApprovalTextField } from "@/components/dashboard/approval-text-field";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  PR_FIX_SESSION_INSTRUCTION,
  prFixRequestActionLabel,
  type PrFixRequestRoute,
} from "@/lib/dispatch/pr-fix-request";

/**
 * PR詳細の「修正Issueを起案」の送り先が新規Issue作成ではないとき（#3009）に開く確認ダイアログ。
 *
 * **新しいIssueは作らず、このPRを実装していたIssueへ指摘を伝える。** 以前はIssue詳細の
 * マージ待ち欄にも同じ修正依頼欄（#2919）があったが、PRへの修正依頼はPR詳細へ一本化した
 * （#3333）。送信は`issue-deck-shell.tsx`の`handlePullRequestFixSessionRequest`が持つ。
 *
 * **押した時点ではGitHubへ何も送らない。** 自動レビューの引用で埋めた初期値を、送るかどうか・
 * どの指摘を残すかは読んだ人が編集してから「送信」を押す。
 */
export function PullRequestFixSessionDialog({
  open,
  route,
  initialReason,
  repositoryFullName,
  issueSuggestions,
  isSubmitting,
  rejection,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** `create-issue`はここに渡さない（呼び出し側が新規Issue作成ダイアログへ倒す） */
  route: PrFixRequestRoute;
  initialReason: string;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  isSubmitting: boolean;
  /** 送れない理由（`session`・`resume`のときだけ意味がある） */
  rejection: string | null;
  /** 送信そのものが失敗した理由（押した後に出る） */
  error: string | null;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [isUploading, setIsUploading] = useState(false);

  const blocked = (route.kind === "session" || route.kind === "resume") && rejection !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prFixRequestActionLabel(route)}</DialogTitle>
          <DialogDescription>
            新しいIssueは作らず、このPRを実装していたIssueへ指摘を伝えます。送る前に内容を編集できます。
          </DialogDescription>
        </DialogHeader>
        <PrFixRouteNotice route={route} rejection={rejection} error={error} />
        <ApprovalTextField
          value={reason}
          onChange={setReason}
          placeholder="修正内容を入力（必須）"
          repositoryFullName={repositoryFullName}
          issueSuggestions={issueSuggestions}
          disabled={isSubmitting}
          onUploadingChange={setIsUploading}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
            キャンセル
          </Button>
          <Button
            onClick={() => onSubmit(reason)}
            disabled={isSubmitting || isUploading || blocked || !reason.trim()}
          >
            {prFixRequestActionLabel(route)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 修正依頼がどこへ送られるのかを、書き始める前に出す（#2919）。
 *
 * **無人実行が担当のときは何も出さない。** 送り先が1つしかない状態で「無人実行へ送ります」と
 * 言っても、読む人が確かめられることが増えない（今までどおりの画面のままにする）。
 *
 * ローカル担当のときだけ出し、**呼び戻すこと・ラベルを外すこと・固定の1行を流すことを押す前に
 * 書く。** 黙って`11.local`が外れると、後から無人実行が動き出した理由を画面から辿れなくなる。
 *
 * #2919ではIssue詳細の修正依頼欄（`MergeApprovalActions`）にあった。PRへの修正依頼をPR詳細へ
 * 一本化した（#3333）ため、いまはこのダイアログだけが使う。
 */
export function PrFixRouteNotice({
  route,
  rejection,
  error,
}: {
  route: PrFixRequestRoute;
  /** 送れない理由（`session`・`resume`のときだけ意味がある） */
  rejection: string | null;
  /** 送信そのものが失敗した理由（押した後に出る） */
  error: string | null;
}) {
  if (route.kind === "actions") return null;

  const hostName = route.kind === "handoff" ? null : formatDispatchHostName(route.host);

  return (
    <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {route.kind === "session" ? (
            <>
              このIssueは{hostName}の
              <strong className="font-medium">セッションが担当中</strong>です（
              <code>11.local</code>が付いている間、無人実行は修正依頼に反応しません）。
              依頼はIssueコメントとして残したうえで、走っているセッションへ知らせます。
            </>
          ) : route.kind === "resume" ? (
            <>
              このIssueを担当していた{hostName}のセッションは
              <strong className="font-medium">終了しています</strong>
              。依頼を投稿したうえで、
              <strong className="font-medium">前回の会話の続きから再開</strong>
              します（worktreeはそのまま・<code>11.local</code>も付いたまま）。
            </>
          ) : (
            <>
              このIssueには<code>11.local</code>が付いていますが、
              <strong className="font-medium">セッションの記録が見当たりません</strong>
              （24時間で消えます）。呼び戻す先が無いので、ラベルを外してから依頼を投稿し、
              無人実行（GitHub Actions）が既存のPull Requestを直せるようにします。
            </>
          )}
        </span>
      </p>
      {/* 送る1行は固定で、押した人が書いた文面はコメントの側に入る（docs/multi-agent/gates.md）。
          何が飛ぶのかを押す前に全文で出す */}
      {route.kind === "session" && (
        <p className="mt-1.5 pl-5">セッションへ送る1行: 「{PR_FIX_SESSION_INSTRUCTION}」</p>
      )}
      {route.kind !== "handoff" && (rejection ?? error) && (
        <p className="mt-1.5 pl-5 text-destructive">{rejection ?? error}</p>
      )}
    </div>
  );
}
