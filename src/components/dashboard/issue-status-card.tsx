"use client";

import { MessageCircleQuestion } from "lucide-react";

import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CheckUserReasonNotice } from "@/components/dashboard/check-user-reason-notice";
import { CrossRepoQuestionJobStatus } from "@/components/dashboard/cross-repo-question-job-status";
import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import { WorkflowStatusSteps } from "@/components/dashboard/workflow-status-steps";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { WorkflowRunInfo } from "@/hooks/use-issue-workflow-run";
import {
  findCrossRepoQuestionJobForIssue,
  findDispatchJobForIssue,
} from "@/lib/dispatch/dispatch-job";
import type { IssueExecutionTarget } from "@/lib/dispatch/issue-execution-target";
import { describeDispatchJobWaitReason } from "@/lib/dispatch/queue-summary";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { CheckUserGuidance } from "@/lib/github/check-user-guidance";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

type IssueStatusCardProps = {
  issue: Issue;
  /** 画面で1回だけ取ったディスパッチの状態（#1262）。取り消し・停止もこの経路で積む */
  dispatch: DispatchStateHandle;
  /** このIssueへ積んだ実装ジョブ（`findDispatchJobForIssue`の結果） */
  dispatchJob: ReturnType<typeof findDispatchJobForIssue>;
  /** 起動済みセッション（`findSessionForIssue`の結果） */
  issueSession: DispatchSessionView | null;
  executionTarget: IssueExecutionTarget;
  workflowRun: WorkflowRunInfo | null;
  workflowRunId: number | null;
  /** Claudeへの質問が回答待ちか（`isQaAnswerPending`の結果） */
  qaAnswerPending: boolean;
  /**
   * 次にどこの何を押せばよいかの案内（#1663・`resolveCheckUserGuidance`の結果）。
   *
   * 解決を親（Issue詳細）に任せているのは、行き先の判定に**このカードが持っていない材料**
   * （マージ待ちかどうか・対応PRのセクションが描かれているか）が要るため。理由ラベルが
   * 読めないリポジトリではnullで、従来どおり進捗ステッパーのバッジだけになる。
   */
  checkUserGuidance?: CheckUserGuidance | null;
};

/**
 * 「いま何が起きているか」を1枚にまとめたカード（#1577）。
 *
 * 進捗ステップ・積んだジョブ・セッションの様子・横断質問・Claudeの回答待ち・実行のキャンセルは
 * どれも同じ問いへの答えなのに、それぞれ独立したブロックとして縦に5段積まれていた。ここで
 * 1枚に収め、**中身が1つも無いIssueではカードごと描かない**（大多数のIssueはむしろ短くなる）。
 *
 * 各子コンポーネントの判定・文言・押せる条件は変えていない。入れ物と並べ方だけを変えている。
 */
export function IssueStatusCard({
  issue,
  dispatch,
  dispatchJob,
  issueSession,
  executionTarget,
  workflowRun,
  workflowRunId,
  qaAnswerPending,
  checkUserGuidance = null,
}: IssueStatusCardProps) {
  // ステップはProject Statusを持たないIssueでは何も描かない（`WorkflowStatusSteps`と同じ判定）
  const hasSteps = getWorkflowStepIndex({ projectStatus: issue.projectStatus }) !== null;
  // 横断質問（#1454）は成功後に`IssueSessionStatus`が引き継ぐので、そこから先は数えない
  const crossRepoJob = findCrossRepoQuestionJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  const hasCrossRepoJob = crossRepoJob !== null && crossRepoJob.status !== "SUCCEEDED";
  // キャンセルボタンが出る条件（`CancelWorkflowRunButton`と同じ判定）
  const hasCancelableRun =
    workflowRun !== null && workflowRun.status !== "completed" && workflowRunId !== null;
  const hasActivity =
    dispatchJob !== null ||
    issueSession !== null ||
    hasCrossRepoJob ||
    qaAnswerPending ||
    hasCancelableRun;

  if (!hasSteps && !hasActivity && !checkUserGuidance) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
      {hasSteps && (
        <WorkflowStatusSteps
          labels={issue.labels}
          projectStatus={issue.projectStatus}
          executionTarget={executionTarget}
        />
      )}

      {/* 確認待ちのIssueを開いた直後に、次に押すものが分かるようにする（#1663）。承認カードは
          コメント欄の末尾にあり、開いた時点では画面に入っていない */}
      {checkUserGuidance && <CheckUserReasonNotice guidance={checkUserGuidance} />}

      {hasActivity && (
        <div className="flex flex-col gap-2 border-t pt-3 empty:hidden">
          {dispatchJob && (
            <DispatchJobStatus
              job={dispatchJob}
              isSubmitting={dispatch.isSubmitting}
              onCancel={() => void dispatch.cancel(dispatchJob.id)}
              waitReason={describeDispatchJobWaitReason(dispatchJob, dispatch.hosts)}
            />
          )}
          {issueSession && (
            <IssueSessionStatus session={issueSession} dispatch={dispatch} align="end" />
          )}
          <CrossRepoQuestionJobStatus issue={issue} dispatch={dispatch} align="end" />
          {(qaAnswerPending || hasCancelableRun) && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {qaAnswerPending && (
                <span className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full bg-blue-500/15 px-3 py-1 text-xs font-medium text-blue-600 ring-1 ring-inset ring-blue-500 md:min-h-0 md:px-2.5 dark:text-blue-400">
                  <MessageCircleQuestion className="size-3" />
                  Claudeの回答待ち
                </span>
              )}
              <CancelWorkflowRunButton
                run={workflowRun}
                runId={workflowRunId}
                repositoryFullName={issue.repositoryFullName}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
