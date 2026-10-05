"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, SendHorizonal, Square, X } from "lucide-react";

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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeSessionControlRejection,
  findSessionControlJobForIssue,
  isActiveDispatchJobStatus,
  parseSessionInstruction,
  resolveSessionControlRejection,
  SESSION_INSTRUCTION_MAX_LENGTH,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  describeSessionPermission,
  describeSessionReap,
  describeSessionStep,
  summarizeIssueSession,
  type IssueSessionTone,
} from "@/lib/dispatch/issue-session";
import { buildSessionOpenTarget } from "@/lib/dispatch/session-open-target";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { SessionTimelineEventView } from "@/lib/dispatch/session-timeline";
import { formatDateTime, formatDateTimeFull, formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { sessionUsageModelLabel } from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

/**
 * 追加指示の定型文（#1012）。**押すのは人**で、入力欄へ差し込むだけにして送らない
 * （送る前に手直しできる形にしておくため）。状況を見て自動で選ぶ実行体は作らない
 * （`docs/multi-agent/gates.md`）。カードの「操作」欄とこのモーダルが共有する。
 */
export const SESSION_INSTRUCTION_PRESETS = [
  "計画を承認します。実装に進んでください。",
  "CIが失敗しています。ログを確認して直してください。",
] as const;

/** タイムラインの種別を日本語の短い印にする。未知の種別は出さない（取り込み時に弾かれる） */
const EVENT_KIND_LABEL: Record<string, string> = {
  assistant: "AI",
  user: "あなた",
  event: "出来事",
  step: "作業",
  waiting: "入力待ち",
  error: "エラー",
};

const TONE_PILL_CLASS: Record<IssueSessionTone, string> = {
  running: "bg-primary/15 text-primary",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  done: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

function Timeline({ sessionId }: { sessionId: string | undefined }) {
  const [events, setEvents] = useState<SessionTimelineEventView[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/dispatch/sessions/${sessionId}/timeline`);
        if (!response.ok || cancelled) return;
        const json = (await response.json()) as { events: SessionTimelineEventView[] };
        setEvents(json.events);
      } catch {
        // 取得できないときは既存のイベントを保持し、次の定期取得で回復を試みる。
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  if (!sessionId) {
    return <p className="text-sm text-muted-foreground">このセッションは詳細ログを取得できません。</p>;
  }
  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">表示できる会話・作業ログはまだありません。</p>;
  }

  return (
    <ol>
      {events.map((event) => (
        <li
          key={event.id}
          className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 border-t py-2.5 first:border-t-0 first:pt-0"
        >
          <time
            className="text-xs tabular-nums text-muted-foreground"
            title={formatDateTimeFull(event.occurredAt)}
          >
            {formatTimeOfDay(event.occurredAt)}
          </time>
          <div className="min-w-0">
            <p className="break-words font-medium">
              {EVENT_KIND_LABEL[event.kind] && (
                <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                  {EVENT_KIND_LABEL[event.kind]}
                </span>
              )}
              {event.title}
            </p>
            {event.body && (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{event.body}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/**
 * セッション詳細（#3991）。右から出るシートをやめ、画面中央のモーダルにした
 * （スマホは下から出るほぼ全画面）。状態・ステップ・ホスト・モデル・起動時刻などを日本語の
 * 一覧で出し、操作は下部に「指示を送る（主）／作業を止める（副）／セッションを終了（危険・右端）」で並べる。
 */
export function SessionDetail({ session, dispatch }: { session: DispatchSessionView; dispatch: DispatchStateHandle }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingKill, setConfirmingKill] = useState(false);
  const summary = summarizeIssueSession(session);
  const controlJob = findSessionControlJobForIssue(
    dispatch.jobs,
    session.repositoryFullName,
    session.issueNumber,
  );
  const controlStatus = controlJob
    ? describeDispatchJobStatus(controlJob.status, controlJob.kind)
    : null;
  const step = describeSessionStep(session);
  const reap = describeSessionReap(session);
  const permission = describeSessionPermission(session);
  const openTarget = buildSessionOpenTarget(session);
  const modelLabel =
    session.models.length > 0 ? session.models.map(sessionUsageModelLabel).join("・") : null;
  const host = dispatch.hosts.find((candidate) => candidate.name === session.host) ?? null;
  const hasActiveControlJob = controlJob !== null && isActiveDispatchJobStatus(controlJob.status);
  const rejection = (kind: "INTERRUPT" | "KILL" | "INSTRUCTION") =>
    resolveSessionControlRejection({ host, session, kind, hasActiveControlJob });
  const interruptRejection = rejection("INTERRUPT");
  const killRejection = rejection("KILL");
  const instructionRejection = rejection("INSTRUCTION");
  // 消えたセッションには操作する相手がいない。停止と追加指示は生きているセッションにだけ出す
  const canControl = session.state !== "GONE";
  const alive = session.state === "ALIVE";
  const instructionBody = parseSessionInstruction(instruction);
  const submit = async (kind: "instruction" | "interrupt" | "kill") => {
    const parsed = kind === "instruction" ? parseSessionInstruction(instruction) : null;
    if (kind === "instruction" && !parsed) {
      setMessage("追加指示は1行で入力してください。");
      return;
    }
    const result = await dispatch.sendSessionControl({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      kind,
      ...(parsed ? { instruction: parsed } : {}),
    });
    setMessage(result.ok ? "操作を送信しました。反映まで最大1分ほどかかります。" : result.message);
    if (result.ok && kind === "instruction") setInstruction("");
  };
  // 押せない理由は押す前に出す。未処理の操作があるときは下のジョブ表示が同じことを言うので出さない
  const visibleRejection = [instructionRejection, interruptRejection, killRejection].find(
    (reason) => reason !== null && reason !== "already_queued",
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        セッション詳細
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "flex h-[min(46rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl",
            // スマホは下から出るほぼ全画面
            "max-sm:top-auto max-sm:bottom-0 max-sm:h-[92%] max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none",
          )}
        >
          <DialogHeader className="gap-1.5 border-b px-4 py-3 pr-12 sm:px-5">
            <p className="text-xs text-muted-foreground">
              {session.repositoryFullName} ・ #{session.issueNumber}
            </p>
            <DialogTitle className="break-words text-base leading-snug">
              {session.issueTitle ?? `Issue #${session.issueNumber}`}
            </DialogTitle>
            <DialogDescription className="sr-only">
              セッションの状態・詳細情報・作業ログと、追加指示・停止・終了の操作を表示します。
            </DialogDescription>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className={cn("rounded-full px-2.5 py-0.5 font-medium", TONE_PILL_CLASS[summary.tone])}>
                {summary.label}
              </span>
              {step && (
                <span className="rounded-full border px-2.5 py-0.5">
                  {step.label}
                  {step.since && <span className="ml-1 tabular-nums opacity-70">{step.since}</span>}
                </span>
              )}
              <span className="rounded-full border px-2.5 py-0.5 text-muted-foreground">
                最終報告 {formatRelativeDate(summary.at)}
              </span>
            </div>
            {summary.detail && <p className="text-sm text-muted-foreground">{summary.detail}</p>}
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_18.5rem] md:overflow-hidden">
            <section className="min-w-0 px-4 py-4 sm:px-5 md:overflow-y-auto max-md:order-2">
              <h3 className="mb-3 text-sm font-semibold">会話・作業ログ</h3>
              <Timeline key={session.id} sessionId={session.id} />
            </section>
            <aside className="flex min-w-0 flex-col gap-4 border-t px-4 py-4 sm:px-5 md:overflow-y-auto md:border-t-0 md:border-l max-md:order-1">
              {permission && (
                <div className="rounded-md bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">承認を待っています</p>
                  <p className="mt-0.5 break-words">
                    ツール: {permission.toolLabel}
                    {permission.target && (
                      <>
                        <br />
                        対象: <span className="break-all font-mono text-xs">{permission.target}</span>
                      </>
                    )}
                  </p>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-sm font-semibold">セッションの情報</h3>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                  <InfoRow label="ホスト">{formatDispatchHostName(session.host)}</InfoRow>
                  {modelLabel && <InfoRow label="モデル">{modelLabel}</InfoRow>}
                  <InfoRow label="起動">{formatDateTime(session.firstSeenAt)}</InfoRow>
                  <InfoRow label="最終報告">{formatDateTime(session.lastReportedAt)}</InfoRow>
                  {reap && <InfoRow label="自動終了">{reap.label}</InfoRow>}
                  {session.exitStatus !== null && <InfoRow label="終了コード">{session.exitStatus}</InfoRow>}
                  <InfoRow label="セッション名">
                    <span className="break-all font-mono text-xs">{session.tmuxSessionName}</span>
                  </InfoRow>
                </dl>
              </div>
              {(openTarget || summary.previewUrl) && (
                <div className="flex flex-wrap gap-2">
                  {openTarget && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={openTarget.url} target="_blank" rel="noreferrer">
                        {openTarget.label}
                        <ExternalLink />
                      </a>
                    </Button>
                  )}
                  {summary.previewUrl && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={summary.previewUrl} target="_blank" rel="noreferrer">
                        開発環境を開く
                        <ExternalLink />
                      </a>
                    </Button>
                  )}
                </div>
              )}
            </aside>
          </div>

          {canControl && (
            <div className="flex flex-col gap-2.5 border-t px-4 py-3 sm:px-5">
              {alive && (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value.replaceAll(/[\r\n]+/g, " "))}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        if (instructionBody && instructionRejection === null) void submit("instruction");
                      }}
                      maxLength={SESSION_INSTRUCTION_MAX_LENGTH}
                      placeholder="セッションへ送る指示（1行）"
                      aria-label="追加指示の本文"
                      disabled={dispatch.isSubmitting}
                    />
                    <Button
                      onClick={() => void submit("instruction")}
                      disabled={instructionBody === null || instructionRejection !== null || dispatch.isSubmitting}
                    >
                      <SendHorizonal />
                      指示を送る
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SESSION_INSTRUCTION_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        variant="ghost"
                        size="sm"
                        className="h-auto px-2 py-1 text-xs"
                        disabled={dispatch.isSubmitting}
                        onClick={() => setInstruction(preset)}
                      >
                        {preset}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {alive && (
                  <Button
                    variant="outline"
                    onClick={() => void submit("interrupt")}
                    disabled={interruptRejection !== null || dispatch.isSubmitting}
                  >
                    <Square />
                    作業を止める
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="ml-auto"
                  onClick={() => setConfirmingKill(true)}
                  disabled={killRejection !== null || dispatch.isSubmitting}
                >
                  <X />
                  セッションを終了
                </Button>
              </div>
              {visibleRejection && (
                <p className="text-xs text-muted-foreground">
                  {describeSessionControlRejection(visibleRejection, {
                    hostName: session.host,
                    kind: visibleRejection === instructionRejection ? "INSTRUCTION" : "KILL",
                  })}
                </p>
              )}
              {message && (
                <p className="text-xs text-muted-foreground" role="status">
                  {message}
                </p>
              )}
              {controlJob && controlStatus && (
                <div className="space-y-1 text-xs" role="status">
                  <p className={controlStatus.tone === "error" ? "text-destructive" : "text-muted-foreground"}>
                    {controlStatus.label}
                    {controlJob.instruction && `「${controlJob.instruction}」`}
                    {isActiveDispatchJobStatus(controlJob.status) && "（反映まで最大1分ほどかかります）"}
                  </p>
                  {controlJob.message && !isActiveDispatchJobStatus(controlJob.status) && (
                    <p className="text-muted-foreground">{controlJob.message}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmingKill} onOpenChange={setConfirmingKill}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このセッションを終了しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{session.tmuxSessionName}」を終了します。作業中の内容はコミットされず、worktreeはそのまま残ります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatch.isSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void submit("kill").finally(() => setConfirmingKill(false));
              }}
            >
              セッション終了
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
