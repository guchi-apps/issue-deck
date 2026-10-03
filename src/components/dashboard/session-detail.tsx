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
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  findSessionControlJobForIssue,
  isActiveDispatchJobStatus,
  parseSessionInstruction,
  SESSION_INSTRUCTION_MAX_LENGTH,
} from "@/lib/dispatch/dispatch-job";
import { describeSessionStep, summarizeIssueSession } from "@/lib/dispatch/issue-session";
import { buildSessionOpenTarget } from "@/lib/dispatch/session-open-target";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { SessionTimelineEventView } from "@/lib/dispatch/session-timeline";
import { formatDateTimeFull, formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";

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
    <ol className="space-y-0">
      {events.map((event) => (
        <li
          key={event.id}
          className="grid grid-cols-[3.5rem_1fr] gap-2 border-t py-3 first:border-t-0 first:pt-0"
        >
          <time className="text-xs text-muted-foreground" title={formatDateTimeFull(event.occurredAt)}>
            {formatTimeOfDay(event.occurredAt)}
          </time>
          <div>
            <p className="font-medium">{event.title}</p>
            {event.body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{event.body}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

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
  const openTarget = buildSessionOpenTarget(session);
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

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        セッション詳細
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>セッション詳細</SheetTitle>
          </SheetHeader>
      <div className="space-y-6 px-4 pb-8 pt-5">
        <div>
          <p className="font-semibold">#{session.issueNumber} {session.issueTitle ?? ""}</p>
          <p className="mt-1 text-sm text-muted-foreground">{summary.label} ・ {formatRelativeDate(summary.at)}</p>
        </div>
        <section className="rounded-lg border p-4">
          <h3 className="font-semibold">現在の状態</h3>
          <p className="mt-2 text-sm">{summary.detail ?? summary.label}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-muted-foreground">ホスト</dt><dd>{session.host}</dd></div>
            <div><dt className="text-muted-foreground">ステップ</dt><dd>{step?.label ?? "取得待ち"}</dd></div>
          </dl>
        </section>
        <section><h3 className="mb-3 font-semibold">会話・作業ログ</h3><Timeline key={session.id} sessionId={session.id} /></section>
        <section className="border-t pt-5"><h3 className="font-semibold">追加指示</h3><div className="mt-3 flex gap-2"><Input value={instruction} onChange={(event) => setInstruction(event.target.value.replaceAll(/[\r\n]+/g, " "))} maxLength={SESSION_INSTRUCTION_MAX_LENGTH} placeholder="セッションへ送る指示（1行）" /><Button onClick={() => void submit("instruction")} disabled={dispatch.isSubmitting}><SendHorizonal />送信</Button></div></section>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void submit("interrupt")} disabled={dispatch.isSubmitting}><Square />停止</Button><Button variant="destructive" onClick={() => setConfirmingKill(true)} disabled={dispatch.isSubmitting}><X />セッション終了</Button>{openTarget && <Button variant="outline" asChild><a href={openTarget.url} target="_blank" rel="noreferrer">{openTarget.label}<ExternalLink /></a></Button>}</div>
        {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
        {controlJob && controlStatus && (
          <div className="space-y-1 text-sm" role="status">
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
        </SheetContent>
      </Sheet>
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
