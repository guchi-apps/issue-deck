"use client";

import {
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeManualStepExecutionRejection,
  findManualStepJobForIssue,
  findManualStepJobForStep,
  isActiveDispatchJobStatus,
  isCancelableDispatchJobStatus,
  resolveManualStepHost,
  resolveManualStepExecutionRejection,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  extractShellBlock,
  isSubpcManualStepDevice,
  MANUAL_STEP_TIMEOUT_SECONDS,
} from "@/lib/manual-step-command";
import type { ManualStepGuide, ManualStepGuideStep } from "@/lib/manual-step-guide";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * 手作業アシスタントの手順を、承認1回でサブPCに代行実行させるパネル（#1828）。
 *
 * **実行できるのは手作業Issueの本文に書かれたコマンドだけで、実行前に全文を画面へ出す。**
 * 画面が送るのは「どの手順か」と「いま出しているコマンド」で、実際に実行されるのはサーバーが
 * 本文から抽出し直したもの（`lib/dispatch/jobs.ts`の`enqueueManualStepJob`）。押した後に本文が
 * 変わっていれば実行されず、理由が返る。
 *
 * **代行できないときもボタンを消さずに理由を出す**（起動ボタン・セッション復旧と同じ作法）。
 * サブPC以外で実行する手作業・コマンドが1つに定まらない手順・pollerが未対応、のどれなのかが
 * 分からないと、人は手元で実行してよいのかを判断できない。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-guide-dialog.tsx`と同じ方針）。
 */
export function ManualStepRunPanel({
  issue,
  guide,
  step,
  dispatch,
  onSucceeded,
}: {
  issue: Issue;
  guide: ManualStepGuide;
  step: ManualStepGuideStep;
  dispatch: DispatchStateHandle;
  /**
   * 終了コード0で終わったときに1回だけ呼ばれる。呼び出し側が手順のチェックを付ける
   * （**チェックの実体はIssue本文**なので、書き換えは既存の`useIssueTaskList`が行う）。
   */
  onSucceeded: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);

  const command = step.line === null ? null : extractShellBlock(step.markdown);
  const host = resolveManualStepHost(dispatch.hosts);
  const job =
    step.line === null
      ? null
      : findManualStepJobForStep(
          dispatch.jobs,
          issue.repositoryFullName,
          issue.number,
          step.line,
        );
  // 同じIssueの**別の手順**が走っている場合（`activeKey`はIssue単位なので積めない）
  const issueJob = findManualStepJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveOtherJob =
    issueJob !== null && isActiveDispatchJobStatus(issueJob.status) && issueJob.id !== job?.id;
  const isRunning = job !== null && isActiveDispatchJobStatus(job.status);

  const rejection = resolveManualStepExecutionRejection({
    host,
    isManualStepIssue: isManualStepIssue(issue.labels),
    isSubpcDevice: isSubpcManualStepDevice(guide.where.device),
    hasCommand: command !== null,
    hasActiveJob: hasActiveOtherJob,
  });

  // 成功を1回だけ拾ってチェックを付ける。**ジョブのidで覚える**ので、ポーリングのたびに
  // 呼び直したり、もう一度実行した結果を取りこぼしたりしない
  const notifiedJobId = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.status !== "SUCCEEDED" || job.exitCode !== 0) return;
    if (notifiedJobId.current === job.id) return;
    notifiedJobId.current = job.id;
    onSucceeded();
  }, [job, onSucceeded]);

  async function handleRun() {
    if (!command || step.line === null || !host) return;
    setError(null);
    setShowOutput(false);
    const result = await dispatch.runManualStep({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: host.name,
      stepLine: step.line,
      command,
    });
    if (!result.ok) setError(result.message);
  }

  // 実行中・実行済みは、押せない理由よりそちらを出す（押した結果の方が直近の事実）
  if (job && (isRunning || job.status !== "QUEUED")) {
    return (
      <ManualStepRunResult
        job={job}
        isRunning={isRunning}
        showOutput={showOutput}
        onToggleOutput={() => setShowOutput((open) => !open)}
        onCancel={
          isCancelableDispatchJobStatus(job.status)
            ? () => void dispatch.cancel(job.id)
            : undefined
        }
        onRetry={isRunning ? undefined : () => void handleRun()}
        isSubmitting={dispatch.isSubmitting}
        error={error}
      />
    );
  }

  if (rejection !== null) {
    return (
      <p className="flex items-start gap-2 rounded-md border bg-muted/50 p-2.5 text-xs text-muted-foreground">
        <Terminal className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {describeManualStepExecutionRejection(rejection, {
            hostName: host?.name ?? "サブPC",
            device: guide.where.device,
          })}
        </span>
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Zap className="size-3.5 shrink-0" aria-hidden />
        {host?.name ?? "サブPC"}で代行実行できます
      </h4>
      {/* **実行するコマンドをもう一度出す。** 上の手順にも同じものが出ているが、承認する対象は
          「本文の手順」ではなく「これから実行される文字列」で、そこがずれていないことを
          押す直前に確かめられるようにする */}
      <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed">
        {command}
      </pre>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        実行するのは上のコマンドそのものです（承認したあとに本文が変わっていた場合は実行しません）。
        出力はこの画面にだけ表示し、GitHubのIssueには残しません。
        <strong className="font-semibold">出力にシークレットが混ざることがあります。</strong>
        {MANUAL_STEP_TIMEOUT_SECONDS / 60}分で打ち切ります。
      </p>
      {error !== null && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={dispatch.isSubmitting} onClick={() => void handleRun()}>
          {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          承認して実行
        </Button>
      </div>
    </section>
  );
}

/** 送信済み・実行中・終わったあとの表示。**終了コードと出力がここにしか残らない** */
function ManualStepRunResult({
  job,
  isRunning,
  showOutput,
  onToggleOutput,
  onCancel,
  onRetry,
  isSubmitting,
  error,
}: {
  job: DispatchJobView;
  isRunning: boolean;
  showOutput: boolean;
  onToggleOutput: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  isSubmitting: boolean;
  error: string | null;
}) {
  const succeeded = job.status === "SUCCEEDED" && job.exitCode === 0;
  const tone = isRunning
    ? "border-amber-500/40 bg-amber-500/5"
    : succeeded
      ? "border-emerald-500/40 bg-emerald-500/5"
      : "border-destructive/40 bg-destructive/5";
  const headingTone = isRunning
    ? "text-amber-700 dark:text-amber-300"
    : succeeded
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-destructive";

  const output = job.commandOutput;
  const outputLines = output === null ? 0 : output.split("\n").length;
  // **失敗したときは最初から開く。** 何が起きたのかを見ずに次へ進める状態にしない
  const outputOpen = showOutput || (!isRunning && !succeeded);

  return (
    <section className={cn("flex flex-col gap-2 rounded-md border p-2.5", tone)}>
      <h4 className={cn("flex items-center gap-1.5 text-xs font-semibold", headingTone)}>
        {isRunning && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
        <span>{describeManualStepRunHeading(job, isRunning, succeeded)}</span>
        {job.finishedAt !== null && (
          <span className="ml-auto font-normal tabular-nums text-muted-foreground">
            {formatRunDuration(job)}
          </span>
        )}
      </h4>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {isRunning
          ? "サブPCが取りに来るまで最大30秒かかります。終わると結果がここに出ます。"
          : succeeded
            ? "この手順にチェックを付けました。"
            : "チェックは付けていません。原因を直してからもう一度実行するか、手元で実行してください。"}
      </p>

      {/* pollerが返した理由（見送り・失敗の説明）。出力とは別物なので分けて出す */}
      {job.message !== null && job.message !== "" && (
        <p className="text-xs text-muted-foreground">{job.message}</p>
      )}

      {output !== null && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={onToggleOutput}
            className="flex items-center gap-1 self-start text-xs font-semibold text-muted-foreground"
            aria-expanded={outputOpen}
          >
            {outputOpen ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            出力（{outputLines}行）
          </button>
          {outputOpen && (
            <pre className="max-h-56 overflow-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {output}
            </pre>
          )}
        </div>
      )}

      {error !== null && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {(onCancel || onRetry) && (
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onCancel}>
              取り消す
            </Button>
          )}
          {onRetry && (
            <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onRetry}>
              もう一度実行
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 見出し。**終了コードを必ず出す。** `succeeded`でも0以外は失敗として扱うため
 * （pollerは「コマンドが終わった」ことを`succeeded`で報告し、成否は終了コードが持つ）。
 */
function describeManualStepRunHeading(
  job: DispatchJobView,
  isRunning: boolean,
  succeeded: boolean,
): string {
  if (isRunning) {
    return job.status === "QUEUED" ? "サブPCへ送信しました" : "サブPCで実行中";
  }
  if (succeeded) return "実行しました（終了コード 0）";
  if (job.exitCode !== null) return `失敗しました（終了コード ${job.exitCode}）`;
  if (job.status === "SKIPPED") return "実行を見送りました";
  if (job.status === "TIMEOUT") return "サブPCへ届きませんでした";
  if (job.status === "CANCELED") return "取り消しました";
  return "実行できませんでした";
}

/** 実行にかかった時間。**開始の報告が届いていなければ出さない**（積んだ時刻からは測らない） */
function formatRunDuration(job: DispatchJobView): string {
  if (job.startedAt === null || job.finishedAt === null) return "";
  const seconds = (new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  return seconds < 60 ? `${seconds.toFixed(1)}秒` : `${Math.round(seconds / 60)}分`;
}
