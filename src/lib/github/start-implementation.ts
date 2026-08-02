import { isApprovalPending } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

/** 「実装を開始」ボタン押下時に投稿する定型コメント本文（claude-issue-dispatch.ymlの@claudeトリガーに反応する） */
export const START_IMPLEMENTATION_COMMENT_BODY = "@claude 実装を開始してください";

/**
 * 未着手（実装状況ラベルが無く、承認待ちでもない）openなissueでのみ
 * 「実装を開始」ボタンを表示する。着手済みissueでは通常のコメント欄から
 * 追加対応(additional)を依頼できるため、このボタンは初回起動専用。
 */
export function canStartImplementation(issue: Pick<Issue, "state" | "labels">): boolean {
  return (
    issue.state === "open" &&
    getWorkflowStepIndex(issue.labels) === null &&
    !isApprovalPending(issue.labels)
  );
}
