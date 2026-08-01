import type { Issue } from "@/types/issue";

// claude-issue-dispatch.yml(Phase5)の起動トリガーに対応する定型コメント。
// 承認コメントのマーカーはワークフロー側の APPROVE_PLAN 判定と対になっている。
export const START_IMPLEMENTATION_COMMENT_BODY = "@claude 実装を開始してください";
export const APPROVE_PLAN_COMMENT_BODY =
  "@claude 計画を承認しました。実装を再開してください。\n\n<!-- issue-deck:approve-plan -->";

// これらのいずれかが付いている場合、issue-<番号>ブランチが既に存在し
// dispatchワークフロー側でも常にskip対象になるため、ボタンは表示しない。
const IN_PROGRESS_LABELS = ["01.wip", "03.d:marge", "05.develop", "07.m:marge", "09.main"];

export type IssueDispatchCta =
  | { mode: "start"; commentBody: string }
  | { mode: "approve"; commentBody: string }
  | { mode: null; commentBody: null };

export function getIssueDispatchCta(issue: Pick<Issue, "state" | "labels">): IssueDispatchCta {
  if (issue.state === "closed") return { mode: null, commentBody: null };

  const labelNames = issue.labels.map((label) => label.name);
  if (labelNames.some((name) => IN_PROGRESS_LABELS.includes(name))) {
    return { mode: null, commentBody: null };
  }

  const awaitingConfirm = labelNames.includes("00.check-user");
  const planRequired = labelNames.includes("21.plan-required");
  if (awaitingConfirm) {
    return planRequired
      ? { mode: "approve", commentBody: APPROVE_PLAN_COMMENT_BODY }
      : { mode: null, commentBody: null };
  }

  return { mode: "start", commentBody: START_IMPLEMENTATION_COMMENT_BODY };
}
