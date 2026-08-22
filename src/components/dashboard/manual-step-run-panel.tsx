"use client";

import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Loader2,
  Search,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ManualStepFixPanel } from "@/components/dashboard/manual-step-fix-panel";
import { ManualStepWhereToRun } from "@/components/dashboard/manual-step-where-to-run";
import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useManualStepFix } from "@/hooks/use-manual-step-fix";
import {
  describeManualStepAbortRejection,
  describeManualStepExecutionRejection,
  findManualStepAbortJobForJob,
  findManualStepJobForIssue,
  findManualStepJobForStep,
  isActiveDispatchJobStatus,
  isCancelableDispatchJobStatus,
  resolveManualStepAbortRejection,
  resolveManualStepHost,
  resolveManualStepExecutionRejection,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import type { ManualStepRunEntry } from "@/lib/manual-step-autorun";
import { isSubpcManualStepDevice, MANUAL_STEP_TIMEOUT_SECONDS } from "@/lib/manual-step-command";
import type { ManualStepGuide } from "@/lib/manual-step-guide";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * 手作業アシスタントの手順・完了の確認を、承認1回でサブPCに代行実行させるパネル（#1828・#1869）。
 *
 * **実行できるのは手作業Issueの本文に書かれたコマンドだけで、実行前に全文を画面へ出す。**
 * 画面が送るのは「どの行か」と「いま出しているコマンド」で、実際に実行されるのはサーバーが
 * 本文から抽出し直したもの（`lib/dispatch/jobs.ts`の`enqueueManualStepJob`）。押した後に本文が
 * 変わっていれば実行されず、理由が返る。
 *
 * **代行できないときもボタンを消さずに理由を出す**（起動ボタン・セッション復旧と同じ作法）。
 * サブPC以外で実行する手作業・コマンドが1つに定まらない手順・pollerが未対応、のどれなのかが
 * 分からないと、人は手元で実行してよいのかを判断できない。
 *
 * **失敗したら原因を調べられる**（#1869）。自動実行中で同意がある場合は自動で調べ、
 * それ以外は「原因を調べる」を押したときだけ調べる（出力をClaudeへ送るため）。
 * 修正案の適用は必ず人が押し、適用すると**本文を書き換えてから**実行する。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-guide-dialog.tsx`と同じ方針）。
 */
export function ManualStepRunPanel({
  issue,
  guide,
  entry,
  dispatch,
  autoDiagnose = false,
  onSucceeded,
  onRetry,
  onApplyFix,
}: {
  issue: Issue;
  guide: ManualStepGuide;
  /** 実行の対象（`## やること`の手順、または`## 完了の確認方法`のコマンド） */
  entry: ManualStepRunEntry;
  dispatch: DispatchStateHandle;
  /** 失敗したときに、押さずに原因を調べてよいか（自動実行の承認に含まれる同意） */
  autoDiagnose?: boolean;
  /**
   * 終了コード0で終わったときに1回だけ呼ばれる。呼び出し側が手順のチェックを付ける
   * （**チェックの実体はIssue本文**なので、書き換えは既存の`useIssueTaskList`が行う）。
   */
  onSucceeded: () => void;
  /**
   * 「もう一度実行」を呼び出し側で扱う場合（#1882）。**自動実行中はここから積まない**——
   * 積むのはサーバーで、画面からも積むと同じ手順が二重に走る。渡さなければ従来どおり
   * このパネルが積む（手順ごとに「承認して実行」を押す使い方。#1828）。
   */
  onRetry?: () => void;
  /**
   * 修正案を本文へ書き戻す（`run`がtrueなら書き戻したあと実行する）。
   * 渡されない場合は修正案の適用ボタンを出さない。
   */
  onApplyFix?: (params: {
    line: number;
    command: string;
    run: boolean;
  }) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const fix = useManualStepFix();

  const command = entry.command;
  const host = resolveManualStepHost(dispatch.hosts);
  const job = findManualStepJobForStep(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
    entry.line,
  );
  // 同じIssueの**別の行**が走っている場合（`activeKey`はIssue単位なので積めない）
  const issueJob = findManualStepJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveOtherJob =
    issueJob !== null && isActiveDispatchJobStatus(issueJob.status) && issueJob.id !== job?.id;
  const isRunning = job !== null && isActiveDispatchJobStatus(job.status);

  const rejection = resolveManualStepExecutionRejection({
    host,
    isManualStepIssue: isManualStepIssue(issue.labels),
    // デバイスは**この項目のもの**（#2052）。実行計画が解決済みなので、ここで引き直さない
    isSubpcDevice: isSubpcManualStepDevice(entry.device),
    hasCommand: command !== null,
    // 対話が要るコマンド（#2025）・プレースホルダ（#2051）かどうかは実行計画が判定済み。
    // ここで見直さない
    interactiveCommand: entry.interactiveCommand,
    placeholder: entry.placeholder,
    hasActiveJob: hasActiveOtherJob,
  });

  const succeeded = job !== null && job.status === "SUCCEEDED" && job.exitCode === 0;
  const failed = job !== null && !isRunning && !succeeded;

  // 成否を1回だけ拾う。**ジョブのidで覚える**ので、ポーリングのたびに呼び直したり、
  // もう一度実行した結果を取りこぼしたりしない
  const notifiedJobId = useRef<string | null>(null);
  useEffect(() => {
    if (!job || isRunning) return;
    if (notifiedJobId.current === job.id) return;
    notifiedJobId.current = job.id;
    if (succeeded) onSucceeded();
  }, [job, isRunning, succeeded, onSucceeded]);

  // 自動実行中の失敗は、押されるのを待たずに原因を調べる（同意がある場合だけ）
  useEffect(() => {
    if (!failed || !autoDiagnose || !job) return;
    void fix.diagnose(job.id);
  }, [failed, autoDiagnose, job, fix]);

  async function handleRun(nextCommand: string | null = command) {
    if (!nextCommand || !host) return;
    setError(null);
    setShowOutput(false);
    fix.dismiss();
    const result = await dispatch.runManualStep({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: host.name,
      stepLine: entry.line,
      command: nextCommand,
    });
    if (!result.ok) setError(result.message);
  }

  async function handleApplyFix(nextCommand: string, options: { run: boolean }) {
    if (!onApplyFix) return;
    setIsApplying(true);
    setError(null);
    const result = await onApplyFix({ line: entry.line, command: nextCommand, run: options.run });
    setIsApplying(false);
    if (!result.ok) {
      setError(result.message ?? "修正を適用できませんでした。");
      return;
    }
    fix.dismiss();
  }

  const fixPanel =
    fix.state !== null && job !== null && fix.state.jobId === job.id ? (
      <ManualStepFixPanel
        fix={fix.state.fix}
        currentCommand={fix.state.currentCommand}
        isApplying={isApplying || dispatch.isSubmitting}
        error={null}
        onApply={
          onApplyFix
            ? (nextCommand, options) => void handleApplyFix(nextCommand, options)
            : () => undefined
        }
        onRetry={() => void handleRun()}
        onDismiss={fix.dismiss}
      />
    ) : null;

  /** 走っている1件を止める（#1882）。届くまで最大1巡（既定30秒）かかる */
  async function handleAbort() {
    if (!job || !host) return;
    setError(null);
    const result = await dispatch.abortManualStep({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: host.name,
      targetJobId: job.id,
    });
    if (!result.ok) setError(result.message);
  }

  // 実行中・実行済みは、押せない理由よりそちらを出す（押した結果の方が直近の事実）
  if (job && (isRunning || job.status !== "QUEUED")) {
    // 走り出した後は取り消せない（#1179）。**代わりに中断ジョブで止める**（#1882）。
    // 止められないホストではボタンを出さず、打ち切りまで待つことを理由として出す
    const abortRejection = job.status === "RUNNING" ? resolveManualStepAbortRejection(host) : null;
    const abortJob = findManualStepAbortJobForJob(dispatch.jobs, job.id);
    return (
      <div className="flex flex-col gap-2">
        <ManualStepRunResult
          job={job}
          entry={entry}
          isRunning={isRunning}
          showOutput={showOutput}
          onToggleOutput={() => setShowOutput((open) => !open)}
          onCancel={
            isCancelableDispatchJobStatus(job.status)
              ? () => void dispatch.cancel(job.id)
              : undefined
          }
          onAbort={
            job.status === "RUNNING" && abortRejection === null && abortJob === null
              ? () => void handleAbort()
              : undefined
          }
          abortNote={
            job.status !== "RUNNING"
              ? null
              : abortJob !== null
                ? "中断を送りました（届くまで最大30秒かかります）。"
                : abortRejection === null
                  ? null
                  : describeManualStepAbortRejection(abortRejection, {
                      hostName: host?.name ?? "サブPC",
                      timeoutMinutes: MANUAL_STEP_TIMEOUT_SECONDS / 60,
                    })
          }
          onRetry={isRunning ? undefined : (onRetry ?? (() => void handleRun()))}
          onDiagnose={
            failed && fixPanel === null && !fix.isLoading ? () => void fix.diagnose(job.id) : undefined
          }
          isDiagnosing={fix.isLoading}
          isSubmitting={dispatch.isSubmitting}
          error={error ?? fix.error}
        />
        {/* 失敗したら、手元で実行するための「どこから」を出す（#1882）。**成功したら出さない**
            ——実行し終えたものについて接続方法を並べても読む相手がいない */}
        {failed && (
          <ManualStepWhereToRun where={guide.where} device={entry.device} command={command} />
        )}
        {fixPanel}
      </div>
    );
  }

  if (rejection !== null) {
    // **確認コマンドには「実行した・次へ」が無い**（チェックが付かないため）。対話が要るコマンド
    // （#2025）・プレースホルダを含むコマンド（#2051）で自動実行が止まったとき、続きへ進める
    // 導線をここに出す。手順はダイアログのフッターの「実行した・次へ」が同じ役目を持つので出さない
    const canContinue =
      onRetry !== undefined &&
      entry.kind === "verification" &&
      (rejection === "interactive_command" || rejection === "placeholder_command");
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-2 rounded-md border bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <Terminal className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {describeManualStepExecutionRejection(rejection, {
              hostName: host?.name ?? "サブPC",
              device: entry.device,
              interactiveCommand: entry.interactiveCommand,
              placeholder: entry.placeholder,
            })}
          </span>
        </p>
        {/* 代行できない手順こそ、どこから実行するのかが要る（#1882） */}
        <ManualStepWhereToRun where={guide.where} device={entry.device} command={command} />
        {canContinue && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onRetry}>
              <ArrowRight />
              自分で実行した・続きへ
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Zap className="size-3.5 shrink-0" aria-hidden />
        {host?.name ?? "サブPC"}で
        {entry.kind === "verification" ? "確認コマンドを実行できます" : "代行実行できます"}
      </h4>
      {/* **実行するコマンドをもう一度出す。** 上の手順にも同じものが出ているが、承認する対象は
          「本文の手順」ではなく「これから実行される文字列」で、そこがずれていないことを
          押す直前に確かめられるようにする */}
      <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed">
        {command}
      </pre>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        実行するのは上のコマンドそのものです（承認したあとに本文が変わっていた場合は実行しません）。
        {entry.kind === "verification" &&
          "実行しても手作業は完了になりません（出力を見て判断してください）。"}
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
          {entry.kind === "verification" ? "承認して確認を実行" : "承認して実行"}
        </Button>
      </div>
    </section>
  );
}

/** 送信済み・実行中・終わったあとの表示。**終了コードと出力がここにしか残らない** */
function ManualStepRunResult({
  job,
  entry,
  isRunning,
  showOutput,
  onToggleOutput,
  onCancel,
  onAbort,
  abortNote,
  onRetry,
  onDiagnose,
  isDiagnosing,
  isSubmitting,
  error,
}: {
  job: DispatchJobView;
  entry: ManualStepRunEntry;
  isRunning: boolean;
  showOutput: boolean;
  onToggleOutput: () => void;
  onCancel?: () => void;
  /** 走っているコマンドを止める（#1882）。止められないホストでは渡さない */
  onAbort?: () => void;
  /** 中断について添える一文（送信済み・止められない理由）。無ければ`null` */
  abortNote?: string | null;
  onRetry?: () => void;
  onDiagnose?: () => void;
  isDiagnosing: boolean;
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
  // **失敗したときは最初から開く。** 何が起きたのかを見ずに次へ進める状態にしない。
  // **完了の確認は成功でも開く**——読むために実行するものなので、畳むと結果を見ずに進める
  const outputOpen =
    showOutput || (!isRunning && !succeeded) || (succeeded && entry.kind === "verification");

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
            ? entry.kind === "verification"
              ? "出力が本文の「期待する出力」と合っているかを確かめてください（チェックは付きません）。"
              : "この手順にチェックを付けました。"
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

      {abortNote != null && abortNote !== "" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{abortNote}</p>
      )}

      {(onCancel || onAbort || onRetry || onDiagnose || isDiagnosing) && (
        <div className="flex flex-wrap justify-end gap-2">
          {onCancel && (
            <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onCancel}>
              取り消す
            </Button>
          )}
          {/* 走り出した1件を止める（#1882）。取り消しと違い、**止まるまでに最大30秒**かかる */}
          {onAbort && (
            <Button variant="outline" size="sm" disabled={isSubmitting} onClick={onAbort}>
              <CircleStop />
              中断する
            </Button>
          )}
          {(onDiagnose || isDiagnosing) && (
            <Button
              variant="outline"
              size="sm"
              disabled={isDiagnosing || isSubmitting}
              onClick={onDiagnose}
            >
              {isDiagnosing ? <Loader2 className="animate-spin" /> : <Search />}
              {isDiagnosing ? "原因を調べています" : "原因を調べる"}
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
