"use client";

import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useLocalSessionLaunch } from "@/hooks/use-local-session-launch";
import {
  ACTIONS_RUNNING_ENQUEUE_REASON,
  describeCrossRepoQuestionRejection,
  describeDispatchEnqueueRejection,
  findBlockingSession,
  findCrossRepoQuestionJobForIssue,
  findDispatchJobForIssue,
  isActionsRunInProgress,
  isActiveDispatchJobStatus,
  resolveCrossRepoQuestionRejection,
  resolveDispatchTargetRejection,
} from "@/lib/dispatch/dispatch-job";
import {
  describeSessionRecovery,
  resolveIssueImplementationAgent,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import { parseRepositoryFullName } from "@/lib/local-session";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * 終了したセッションを1クリックで呼び戻す（#1830）。
 *
 * **呼び戻す仕組み自体は前からある。** worktreeを消していなければランチャーが
 * `claude --continue`を渡し、前回の会話の続きから再開する（#1541）。無かったのは画面の導線で、
 * 終了したセッションの行は「サブPC・終了」と出て操作がすべて消え、起動は別の場所にある
 * 「サブPCで開始」（新規に始めるのと同じ文言）を探して押すしかなかった。**回答が遅れて
 * セッションが畳まれた人が見ているのは終了した行の方**なので、押す場所をそこへ置く。
 *
 * 積むのは起動ジョブ（`LAUNCH`）で、`StartLocalSessionButton`とまったく同じ
 * （`useLocalSessionLaunch`）。**issue-deck側は「もう一度起動する」以上のことをしない**
 * ——session idもホストの内部状態も持たない、という取り決め（#1541）は変えていない。
 *
 * **押せない理由は押す前に出し、ボタンごと消さない**（#1332の「停止」と同じ立場）。導線ごと
 * 消すと、なぜ復旧できないのか（サブPCが落ちている・もう起動済み）が画面から分からなくなる。
 *
 * **横断質問セッション（#1454）も復旧できる**（#3033）。ただし積むのは`LAUNCH`ではなく質問ジョブ
 * （`CROSS_REPO_QUESTION`）で、`11.local`は付けない（記録先の`question`リポジトリに無人実行は
 * 無く、実装のためのラベルでもない）。会話がcwd（質問Issue間で共有）に紐づくため`--continue`は
 * 使えない（#1648）が、ランチャーが質問Issueごとに控えたsessionIdで`--resume`する
 * （`scripts/run-issue-session.sh`）ので、issue-deck側はここでも「もう一度起動する」以上のことをしない。
 */
export function SessionRecoveryButton({
  issue,
  session,
  dispatch,
  actionsRun,
  onIssueUpdated,
  align = "end",
}: {
  issue: Issue;
  /** そのIssueのセッション（`findSessionForIssue`の結果） */
  session: DispatchSessionView;
  /** 画面で1回だけ取ったディスパッチの状態（#1262） */
  dispatch: DispatchStateHandle;
  /**
   * そのIssueで走っているGitHub Actionsの実行（#2032・`useIssueWorkflowRun`の`run`）。
   *
   * **進行中なら押させない。** ローカルで着手したIssueは`11.local`を外して無人実行へ
   * 引き継ぐため、「終了したセッションの行」と「Actionsの実行中」は日常的に重なる
   * （セッションの記録は24時間残る）。そこで押すと、Actionsと同じブランチをサブPCが
   * 別に進めることになる
   */
  actionsRun?: { status: string } | null;
  onIssueUpdated: (issue: Issue) => void;
  /** 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せ */
  align?: "start" | "end";
}) {
  const { launch, isSubmitting, error } = useLocalSessionLaunch({
    issue,
    dispatch,
    onIssueUpdated,
  });

  // 横断質問セッション（#1454）か。判定材料は、そのセッションを立てた質問ジョブ——終了した
  // セッションの行と同じく24時間は画面に残るので、行が出ている間は必ず突き合わせられる
  const questionJob = findCrossRepoQuestionJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  const isQuestion = questionJob !== null;

  const recovery = describeSessionRecovery(session, { isCrossRepoQuestion: isQuestion });
  // closedなIssue・手作業Issueには起動する相手がいない（`StartLocalSessionButton`と同じ判定）
  const isAvailable =
    parseRepositoryFullName(issue.repositoryFullName) !== null &&
    issue.state === "open" &&
    !isManualStepIssue(issue.labels);

  const host = dispatch.hosts.find((candidate) => candidate.name === session.host) ?? null;
  const job = findDispatchJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  // 未処理のジョブは、積む種別のものだけを見る（質問を積む導線が実装の起動ジョブに塞がれない）
  const relevantJob = isQuestion ? questionJob : job;
  const hasActiveJob = relevantJob !== null && isActiveDispatchJobStatus(relevantJob.status);
  // 既に立ち上がり直している場合は積ませない（#1311と同じ判定）
  const blockingSession = findBlockingSession({
    sessions: dispatch.sessions,
    hosts: dispatch.hosts,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });
  const questionRejection = isQuestion
    ? resolveCrossRepoQuestionRejection({ host, hasActiveJob, blockingSession })
    : null;
  const launchRejection = isQuestion
    ? null
    : resolveDispatchTargetRejection({
        host,
        repositoryFullName: issue.repositoryFullName,
        hasActiveJob,
        blockingSession,
      });
  const rejection = questionRejection ?? launchRejection;

  // Actionsが走っている間は復旧させない（#2032）。**ボタンごと消さず、理由を出して押せなく
  // する**——このコンポーネントは「なぜ復旧できないのかを画面から分かるようにする」ために
  // 導線を残す方針で作られている（`rejection`の扱いと同じ）。質問セッションはActionsと
  // 同じブランチを進める心配が無いので見ない
  const actionsRunning = !isQuestion && isActionsRunInProgress(actionsRun);

  if (!recovery || !isAvailable) return null;

  const rejectionMessage = questionRejection
    ? describeCrossRepoQuestionRejection(questionRejection, { hostName: session.host })
    : launchRejection
      ? describeDispatchEnqueueRejection(launchRejection, {
          hostName: session.host,
          repositoryFullName: issue.repositoryFullName,
          session: blockingSession,
        })
      : null;
  const textClassName = cn(
    "w-full break-words text-xs text-muted-foreground",
    align === "end" ? "text-right" : "text-left",
  );

  function recover() {
    if (isQuestion) {
      void dispatch.enqueue({
        repositoryFullName: issue.repositoryFullName,
        issueNumber: issue.number,
        hostName: session.host,
        kind: "cross_repo_question",
      });
      return;
    }
    void launch(session.host, resolveIssueImplementationAgent(session));
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      {/* スマホ（主な用途）では幅いっぱいにして押しやすくし、PCの列では文字幅に収める */}
      <Button
        variant={recovery.primary ? "default" : "outline"}
        size="sm"
        className="w-full sm:w-auto"
        disabled={isSubmitting || rejection !== null || actionsRunning}
        onClick={recover}
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        セッションを復旧
      </Button>
      {/* 押すと何が起きるかは常に出す。**畳まない。** 「復旧」だけでは、会話が続くのか
          最初からやり直すのかが読み取れず、押してよいか判断できない */}
      <p className={textClassName}>{recovery.detail}</p>
      {/* 押せない理由（#1180「選べない理由は押す前に出す」）。未処理のジョブがある場合は
          ジョブの状態表示が同じことを言うので出さない */}
      {rejectionMessage && rejection !== "already_queued" && (
        <p className={textClassName}>{rejectionMessage}</p>
      )}
      {/* Actionsの実行中（#2032）。押せない理由が2つ重なることはあるが、
          先に消えるのはActions側とは限らないので両方出す */}
      {actionsRunning && <p className={textClassName}>{ACTIONS_RUNNING_ENQUEUE_REASON}</p>}
      {(error || dispatch.error) && (
        <p className={cn(textClassName, "text-destructive")}>{error ?? dispatch.error}</p>
      )}
    </div>
  );
}
