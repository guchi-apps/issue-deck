"use client";

import { MessageCircleQuestion, Server } from "lucide-react";

import { CancelWorkflowRunButton } from "@/components/dashboard/cancel-workflow-run-button";
import { CheckUserReasonNotice } from "@/components/dashboard/check-user-reason-notice";
import { CodeReviewJobStatus } from "@/components/dashboard/code-review-job-status";
import { CrossRepoQuestionJobStatus } from "@/components/dashboard/cross-repo-question-job-status";
import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import { SessionRecoveryButton } from "@/components/dashboard/session-recovery-button";
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
  /** ラベルを更新したときに親へ返す（セッションの復旧が`11.local`を付け直す。#1830） */
  onIssueUpdated: (issue: Issue) => void;
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
  /**
   * 計画フェーズを通らずに実装へ入ったIssueかどうか（#2069・`isPlanningPhaseSkipped`の結果）。
   *
   * 判定にIssueのコメントが要るため、解決は親（Issue詳細）に任せている。このカードは
   * コメントを持っておらず、ここで取り直すと同じ取得が2本走る。
   */
  planningSkipped?: boolean;
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
  onIssueUpdated,
  dispatch,
  dispatchJob,
  issueSession,
  executionTarget,
  workflowRun,
  workflowRunId,
  qaAnswerPending,
  checkUserGuidance = null,
  planningSkipped = false,
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
  /**
   * ジョブもセッションも届いていないのに、ローカルで動いていることだけが分かっている状態（#1815）。
   *
   * 実行を開始した直後・端末から`start-issue.sh`で起こした場合・記録が24時間で落ちた後が
   * これにあたる。**開始の主導線（塗りつぶしのボタン）はこの状態でも引っ込める**ため、
   * 代わりに何が起きているのかを1行出す。出さないとカードごと描かれず、押した結果が
   * 画面から消えるだけになる。判定・文言はコメント欄の案内（`LocalSessionCommentNotice`）と
   * 同じく`11.local`を根拠にする（`resolveIssueExecutionTarget`）。
   */
  const localOnly =
    !executionTarget.expectsActionsRun && dispatchJob === null && issueSession === null;
  const hasActivity =
    dispatchJob !== null ||
    issueSession !== null ||
    localOnly ||
    hasCrossRepoJob ||
    qaAnswerPending ||
    hasCancelableRun;
  /**
   * 起動ジョブの行をセッションの行へ畳むか（#1676）。
   *
   * 起動が成功していてセッションが立っていれば、2つは同じ「サブPCで動いている」ことを
   * 2行で言っているだけになる。**起動が終わっていないあいだは畳まない**（「順番待ちの理由」
   * 「失敗理由」「取り消し」は`DispatchJobStatus`にしか無い）。
   */
  const foldedLaunchJob =
    issueSession !== null && dispatchJob?.status === "SUCCEEDED" ? dispatchJob : null;

  if (!hasSteps && !hasActivity && !checkUserGuidance) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
      {/* 同じことを2回言わせない（#2057）。確認待ちのバッジは真下の案内パネルが見出しで
          言い、実行先（「サブPCで実行中」）は下のセッションの行が言う。どちらも出ないときだけ
          ステッパーが受け持つ */}
      {hasSteps && (
        <WorkflowStatusSteps
          labels={issue.labels}
          projectStatus={issue.projectStatus}
          executionTarget={executionTarget}
          showApprovalBadge={checkUserGuidance === null}
          showExecutionTarget={issueSession === null}
          planningSkipped={planningSkipped}
        />
      )}

      {/* 確認待ちのIssueを開いた直後に、次に押すものが分かるようにする（#1663）。承認カードは
          コメント欄の末尾にあり、開いた時点では画面に入っていない */}
      {checkUserGuidance && <CheckUserReasonNotice guidance={checkUserGuidance} />}

      {hasActivity && (
        <div className="flex flex-col gap-2 border-t pt-3 empty:hidden">
          {dispatchJob && !foldedLaunchJob && (
            <DispatchJobStatus
              job={dispatchJob}
              isSubmitting={dispatch.isSubmitting}
              onCancel={() => void dispatch.cancel(dispatchJob.id)}
              waitReason={describeDispatchJobWaitReason(dispatchJob, dispatch.hosts)}
            />
          )}
          {issueSession && (
            <IssueSessionStatus
              session={issueSession}
              dispatch={dispatch}
              align="end"
              launchJob={foldedLaunchJob}
            />
          )}
          {/* 終了したセッションを呼び戻す（#1830）。**終了した行のすぐ下に置く。**
              押す人が見ているのは「終了しました」と出ている場所で、そこから別の場所にある
              起動ボタンを探させると、会話の続きから戻れること自体に気づけない */}
          {issueSession && (
            <SessionRecoveryButton
              issue={issue}
              session={issueSession}
              dispatch={dispatch}
              actionsRun={workflowRun}
              onIssueUpdated={onIssueUpdated}
              align="end"
            />
          )}
          {localOnly && (
            <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs">
              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground ring-1 ring-inset ring-border">
                <Server className="size-3.5" />
                ローカルで対応中
              </span>
              <span className="text-muted-foreground">
                無人実行（GitHub Actions）はこのIssueに反応しません
              </span>
            </div>
          )}
          <CrossRepoQuestionJobStatus issue={issue} dispatch={dispatch} align="end" />
          <CodeReviewJobStatus issue={issue} dispatch={dispatch} align="end" />
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
