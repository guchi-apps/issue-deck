"use client";

import { useState } from "react";

import { ApprovalTextField } from "@/components/dashboard/approval-text-field";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { PrFixRouteNotice } from "@/components/dashboard/merge-approval-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { prFixRequestActionLabel, type PrFixRequestRoute } from "@/lib/dispatch/pr-fix-request";

/**
 * PR詳細の「修正Issueを起案」の送り先が新規Issue作成ではないとき（#3009）に開く確認ダイアログ。
 *
 * **新しいIssueは作らず、このPRを実装していたIssueへ指摘を伝える。** `MergeApprovalActions`の
 * 修正依頼欄（#2919）と役割・送信ロジックは同じで、違うのは常駐のカードかダイアログかだけ——
 * こちらはPR詳細から単発で開くため、内容の確認と送信を1つのダイアログにまとめている。
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
