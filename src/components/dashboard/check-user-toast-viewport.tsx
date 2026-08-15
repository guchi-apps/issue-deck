"use client";

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { checkUserReason, CHECK_USER_REASON_TEXT } from "@/lib/github/approval-labels";
import type { Issue } from "@/types/issue";

export type CheckUserToastItem = {
  // issue.idだけだとラベル解除→再付与で同じキーになり、直前のトーストと区別できないため
  // 検知時刻を含めて一意にする
  id: string;
  issue: Issue;
};

type CheckUserToastViewportProps = {
  toasts: CheckUserToastItem[];
  onSelectIssue: (issue: Issue) => void;
  onDismiss: (id: string) => void;
};

const TOAST_DURATION_MS = 6000;

export function CheckUserToastViewport({
  toasts,
  onSelectIssue,
  onDismiss,
}: CheckUserToastViewportProps) {
  return (
    <ToastProvider duration={TOAST_DURATION_MS} swipeDirection="right">
      {toasts.map(({ id, issue }) => {
        // 何を求められているかを添える（#1490）。理由ラベルが配られていないリポジトリでは
        // nullになり、従来どおり「確認待ちになりました」だけを出す
        const reason = checkUserReason(issue.labels);
        return (
          <Toast
            key={id}
            onOpenChange={(open) => {
              if (!open) onDismiss(id);
            }}
          >
            <button
              type="button"
              onClick={() => {
                onSelectIssue(issue);
                onDismiss(id);
              }}
              className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
            >
              <ToastTitle className="line-clamp-2">{issue.title}</ToastTitle>
              <ToastDescription>
                {issue.repositoryFullName.split("/")[1]} が確認待ちになりました
                {reason ? `（${CHECK_USER_REASON_TEXT[reason]}）` : ""}
              </ToastDescription>
            </button>
            <ToastClose />
          </Toast>
        );
      })}
      {/* スマホはボトムナビ（min-h-14）及び「コメント欄へ移動」ボタンと、PCも同ボタンと
          重ならないよう底上げする */}
      <ToastViewport className="bottom-20 md:bottom-16" />
    </ToastProvider>
  );
}
