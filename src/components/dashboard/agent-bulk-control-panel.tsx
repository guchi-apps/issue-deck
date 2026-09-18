"use client";

import { Play, Square } from "lucide-react";
import { useState } from "react";

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
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { AGENT_RESUME_INSTRUCTION, selectStoppedSessions } from "@/lib/dispatch/agent-resume";
import { describeDispatchAgent, DISPATCH_AGENTS, type DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { cn } from "@/lib/utils";

/**
 * エージェント（Claude Code・Codex CLI）ごとに、実行中セッションの一括停止と新規実行の
 * 一時停止トグルを1行にまとめて出す（#2994）。
 *
 * **押すのは人。** トグルをOFFにする操作が「動いているセッションへ中断を送る」と
 * 「新規実行をブロックする」を1回で兼ねる——個別の「止める」ボタンは置かない。送るのは
 * 既存の個別「停止」ボタン（#1332）と同じ固定のC-cのみで、対象セッションの本数ぶん
 * 繰り返すだけ（内容を判断して組み立てる文字列は無い）。
 *
 * **自動検知（サブスク枠の使い切り）は動いているセッションへ何も送らない。** サーバー側の
 * スイープ（`sweepAgentUsageLimitPause`）が一時停止のフラグを立てる／解くだけで、
 * 中断の送出は人がトグルを手動でOFFにしたときに限る。`docs/multi-agent/gates.md`の
 * 「例外は4つ」に新しい例外を足す必要が無いのはこのため。「実行中」と「停止中（自動）」は
 * 独立した状態で、両方同時に成立しうる——このときは状態チップを両方出す。
 *
 * **トグルの左に「停止」／「再開」ボタンを置く**（#3045）。稼働中は「停止」、停止中は「再開」で、
 * どちらも確認ダイアログを挟む。「停止」はトグルをOFFにするのと同じ処理。「再開」は新規実行の
 * ブロック解除に加えて、**一括停止で止まったセッションへ固定の1行を送って続きから動かす**
 * （`POST /api/dispatch/agent-resume`。送る対象と本文はサーバーが決める）。**トグルだけをONにした
 * 場合はブロック解除のみで、セッションは再開しない。** 再開で送る固定文面は`gates.md`の例外2の内側。
 */
export function AgentBulkControlPanel({ dispatch }: { dispatch: DispatchStateHandle }) {
  // 申告しているサブPCが1台も無ければ、一時停止という概念自体が無い
  // （`dispatch-queue-button.tsx`と同じ判定）
  if (dispatch.hosts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">エージェントを一括操作</p>
      <div className="flex flex-col gap-1.5">
        {DISPATCH_AGENTS.map((agent) => (
          <AgentBulkControlRow key={agent} agent={agent} dispatch={dispatch} />
        ))}
      </div>
    </div>
  );
}

function AgentBulkControlRow({
  agent,
  dispatch,
}: {
  agent: DispatchAgent;
  dispatch: DispatchStateHandle;
}) {
  const [confirming, setConfirming] = useState(false);
  const [resumeConfirming, setResumeConfirming] = useState(false);
  // 停止の失敗は押した場所に出す（`issue-session-status.tsx`の`controlError`と同じ扱い）
  const [error, setError] = useState<string | null>(null);

  const aliveSessions: DispatchSessionView[] = dispatch.sessions.filter(
    (session) => session.state === "ALIVE" && resolveIssueImplementationAgent(session) === agent,
  );
  const pauseReason = dispatch.agentPause[agent];
  // トグルON＝稼働中（一時停止理由が無い）。OFF＝停止中（手動・自動のどちらでも）
  const running = pauseReason === null;
  // 再開の対象の目安。**実際に送る対象はサーバーが選び直す**（同じ判定関数を使うが、こちらは
  // 画面が持つ直近24時間のジョブしか見えない）
  const resumableSessions = selectStoppedSessions(
    dispatch.sessions.filter((session) => resolveIssueImplementationAgent(session) === agent),
    dispatch.jobs,
  );

  async function turnOn() {
    setError(null);
    const result = await dispatch.setAgentDispatchPaused({ agent, paused: false });
    if (!result.ok) setError(result.message);
  }

  async function resumeConfirmed() {
    setError(null);
    const result = await dispatch.resumeAgentSessions({ agent });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // 一部へ積めなくても解除は成立している。最初の理由だけを出す（複数出すと押した場所が埋まる）
    const first = result.failed[0];
    if (first) {
      setError(`${first.repositoryFullName}#${first.issueNumber}: ${first.message}`);
    }
  }

  async function turnOffConfirmed() {
    setError(null);
    const paused = await dispatch.setAgentDispatchPaused({ agent, paused: true });
    if (!paused.ok) {
      setError(paused.message);
      return;
    }
    // 押した時点でALIVEだったセッションへ、1件ずつ固定のC-cを送る（#1332と同じ経路）。
    // 送信そのものはpollerの次の巡回（既定30秒）で届くため、ここでは積むところまで
    for (const session of aliveSessions) {
      const sent = await dispatch.sendSessionControl({
        repositoryFullName: session.repositoryFullName,
        issueNumber: session.issueNumber,
        hostName: session.host,
        kind: "interrupt",
      });
      // 1件失敗しても残りは送り続ける。最初のエラーだけを出す（複数出すと押した場所が埋まる）
      if (!sent.ok) setError((prev) => prev ?? sent.message);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-background p-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            agent === "claude" ? "bg-indigo-500" : "bg-teal-600",
          )}
        />
        <span className="text-sm font-semibold">{describeDispatchAgent(agent)}</span>
        <div className="ml-auto flex items-center gap-2.5">
          {running ? (
            <button
              type="button"
              aria-label={`${describeDispatchAgent(agent)}を停止`}
              disabled={dispatch.isSubmitting}
              onClick={() => setConfirming(true)}
              className="inline-flex h-[26px] items-center gap-1 rounded-md border border-red-500/50 pr-2.5 pl-2 text-xs font-bold text-red-600 disabled:opacity-50 dark:text-red-400"
            >
              <Square className="size-3 fill-current" aria-hidden />
              停止
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${describeDispatchAgent(agent)}を再開`}
              disabled={dispatch.isSubmitting}
              onClick={() => setResumeConfirming(true)}
              className="inline-flex h-[26px] items-center gap-1 rounded-md border border-emerald-500/50 pr-2.5 pl-2 text-xs font-bold text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
            >
              <Play className="size-3 fill-current" aria-hidden />
              再開
            </button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={running}
            aria-label={`${describeDispatchAgent(agent)}の実行状態`}
            title={running ? "稼働中（押すと停止します）" : "停止中（押すと新規実行のブロックだけ解除します。止めたセッションは「再開」から）"}
            disabled={dispatch.isSubmitting}
            onClick={() => (running ? setConfirming(true) : void turnOn())}
            className={cn(
              "inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
              running ? "bg-emerald-600" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "size-[15px] rounded-full bg-white shadow transition-transform",
                running ? "translate-x-[17px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>
      {(aliveSessions.length > 0 || pauseReason) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {aliveSessions.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              実行中
            </span>
          )}
          {pauseReason && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                pauseReason === "usage_limit"
                  ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              停止中（{pauseReason === "usage_limit" ? "自動" : "手動"}）
            </span>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{describeDispatchAgent(agent)}を停止しますか？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  動いているセッション（{aliveSessions.length}件）へ中断（Ctrl-C相当）を送り、新規実行も
                  ブロックします。セッション自体は残り、「再開」を押すと続きから動かせます
                  （トグルをオンにするだけなら、新規実行のブロック解除だけで、止めたセッションは
                  動きません）。
                </p>
                {aliveSessions.length > 0 && (
                  <ul className="mt-2 list-disc pl-4">
                    {aliveSessions.map((session) => (
                      <li key={`${session.host}:${session.tmuxSessionName}`}>
                        {session.repositoryFullName}#{session.issueNumber}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatch.isSubmitting}
              onClick={(event) => {
                // 送信の結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                event.preventDefault();
                void turnOffConfirmed().finally(() => setConfirming(false));
              }}
            >
              停止する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resumeConfirming} onOpenChange={setResumeConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{describeDispatchAgent(agent)}を再開しますか？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  新規実行のブロックを解除し、一括停止で作業を中断されたセッションへ次の1行を送ります。
                  質問や承認の返事を待っていたセッション、承認プロンプト・選択フォームの表示中の
                  セッションには送りません。
                </p>
                <p className="mt-2 rounded border bg-muted px-2 py-1 text-foreground">
                  {AGENT_RESUME_INSTRUCTION}
                </p>
                {resumableSessions.length > 0 && (
                  <>
                    <p className="mt-2">再開の対象（{resumableSessions.length}件）</p>
                    <ul className="mt-1 list-disc pl-4">
                      {resumableSessions.map((session) => (
                        <li key={`${session.host}:${session.tmuxSessionName}`}>
                          {session.repositoryFullName}#{session.issueNumber}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatch.isSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void resumeConfirmed().finally(() => setResumeConfirming(false));
              }}
            >
              再開する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
