"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  HandHelping,
  Loader2,
  Monitor,
  OctagonX,
  Square,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeSessionControlRejection,
  findSessionControlJobForIssue,
  isActiveDispatchJobStatus,
  resolveSessionControlRejection,
  SESSION_CONTROL_LABELS,
} from "@/lib/dispatch/dispatch-job";
import {
  summarizeIssueSession,
  type IssueSessionTone,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 起動したセッションの様子を出す（#1264）と、そこから止める（#1332）。
 *
 * **`DispatchJob`の状態表示（`dispatch-job-status.tsx`）が終わるところから先を担当する。**
 * ジョブの寿命は「tmuxセッションが立った」までで、その後セッションが生きているのか・人の入力を
 * 待っているのか・落ちたのかは画面のどこにも出ていなかった。
 *
 * **入力待ちのときはRemote ControlのURLを出す。** これが承認の唯一の出口で、従来はSignalyの
 * 通知の中にしか無く、通知を消すと承認待ちであること自体を知る手段が無くなっていた。
 *
 * **画面から送るのは「停止（C-c）」と「セッションを閉じる」の2つだけで、入力そのものは送らない**
 * （`docs/multi-agent/gates.md`の禁止事項。文字列と確定キーを送って選択フォームに誤答させた
 * 事故がある）。答えるのはRemote Control側の役目のまま。
 *
 * 実行はサブPCのpollerが次の巡（既定60秒間隔）で行うため、押した直後は「送信しました」を出す。
 *
 * 配色は`dispatch-job-status.tsx`に揃えている。
 */

const TONE_CLASS: Record<IssueSessionTone, string> = {
  running: "bg-primary/15 text-primary ring-primary",
  waiting: "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
  done: "bg-muted text-muted-foreground ring-border",
  error: "bg-destructive/15 text-destructive ring-destructive",
};

function ToneIcon({ tone }: { tone: IssueSessionTone }) {
  const className = "size-3.5";
  switch (tone) {
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "waiting":
      return <HandHelping className={className} />;
    case "done":
      return <CheckCircle2 className={className} />;
    case "error":
      return <AlertTriangle className={className} />;
  }
}

export function IssueSessionStatus({
  session,
  dispatch,
  align = "end",
}: {
  session: DispatchSessionView;
  /** 画面で1回だけ取ったディスパッチの状態（#1262）。停止・終了もこの経路で積む */
  dispatch: DispatchStateHandle;
  /** 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せ */
  align?: "start" | "end";
}) {
  const summary = summarizeIssueSession(session);
  const [confirmingKill, setConfirmingKill] = useState(false);
  // 停止の失敗は押した場所に出す（`dispatch.error`は起動ボタンの下に出るため、そちらへ流さない）
  const [controlError, setControlError] = useState<string | null>(null);

  const host = dispatch.hosts.find((candidate) => candidate.name === session.host) ?? null;
  const controlJob = findSessionControlJobForIssue(
    dispatch.jobs,
    session.repositoryFullName,
    session.issueNumber,
  );
  const hasActiveControlJob = controlJob !== null && isActiveDispatchJobStatus(controlJob.status);
  const interruptRejection = resolveSessionControlRejection({
    host,
    session,
    kind: "INTERRUPT",
    hasActiveControlJob,
  });
  const killRejection = resolveSessionControlRejection({
    host,
    session,
    kind: "KILL",
    hasActiveControlJob,
  });
  // 消えたセッションには操作する相手がいない。`EXITED`/`FAILED`（ペインが残っている）は
  // 「閉じる」で片付けられるため、そちらは出したままにする
  const canControl = session.state !== "GONE";
  const showInterrupt = canControl && session.state === "ALIVE";

  async function send(kind: "interrupt" | "kill") {
    setControlError(null);
    const result = await dispatch.sendSessionControl({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      kind,
    });
    if (!result.ok) setControlError(result.message);
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
          TONE_CLASS[summary.tone],
        )}
      >
        <ToneIcon tone={summary.tone} />
        {summary.label}
        {/* 添える時刻は文言に合わせる（#1353）。pollerが1巡ごとに更新するlastReportedAtを
            入力待ちに添えると、何時間前の入力待ちでも「たった今」に見える */}
        <span className="opacity-70">{formatRelativeDate(summary.at)}</span>
      </span>
      {/* 理由・案内はホバーではなく本文として出す（主な用途が外出先のスマホでホバーが無い） */}
      {summary.detail && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {summary.detail}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {summary.remoteControlUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={summary.remoteControlUrl} target="_blank" rel="noreferrer">
              Remote Controlで開く
              <ExternalLink />
            </a>
          </Button>
        )}
        {/* tailnet内からしか開けない（#1265）。スマホがtailnetにいれば押せる */}
        {summary.previewUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={summary.previewUrl} target="_blank" rel="noreferrer">
              <Monitor />
              開発環境を開く
            </a>
          </Button>
        )}
        {showInterrupt && (
          <Button
            variant="outline"
            size="sm"
            disabled={interruptRejection !== null || dispatch.isSubmitting}
            onClick={() => void send("interrupt")}
          >
            <Square />
            {SESSION_CONTROL_LABELS.INTERRUPT.action}
          </Button>
        )}
        {canControl && (
          <Button
            variant="outline"
            size="sm"
            disabled={killRejection !== null || dispatch.isSubmitting}
            onClick={() => setConfirmingKill(true)}
          >
            <OctagonX />
            {SESSION_CONTROL_LABELS.KILL.action}
          </Button>
        )}
      </div>
      {/* 押せない理由は押す前に出す（#1180の「選べない理由は押す前に出す」と同じ立場）。
          未処理の操作がある場合は、下のジョブの状態表示が同じことを言うので出さない */}
      {canControl && killRejection !== null && killRejection !== "already_queued" && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {describeSessionControlRejection(killRejection, {
            hostName: session.host,
            kind: "KILL",
          })}
        </p>
      )}
      {/* 押した操作がどこまで進んだか。pull型なので届くまで最大1分ほど何も起きない */}
      {controlJob && (
        <p
          className={cn(
            "w-full break-words text-xs",
            align === "end" ? "text-right" : "text-left",
            describeDispatchJobStatus(controlJob.status, controlJob.kind).tone === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {describeDispatchJobStatus(controlJob.status, controlJob.kind).label}
          {isActiveDispatchJobStatus(controlJob.status) && "（反映まで最大1分ほどかかります）"}
        </p>
      )}
      {controlError && (
        <p
          className={cn(
            "w-full break-words text-xs text-destructive",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {controlError}
        </p>
      )}

      <AlertDialog open={confirmingKill} onOpenChange={setConfirmingKill}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このセッションを閉じますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {session.host}の「{session.tmuxSessionName}」を終了します。作業中の内容は
              コミットされず、worktreeはそのまま残ります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 送信の結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                event.preventDefault();
                void send("kill").finally(() => setConfirmingKill(false));
              }}
              disabled={dispatch.isSubmitting}
            >
              {SESSION_CONTROL_LABELS.KILL.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
