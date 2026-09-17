"use client";

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
import { describeDispatchAgent, DISPATCH_AGENTS, type DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { cn } from "@/lib/utils";

/**
 * エージェット（Claude Code・Codex CLI）ごとに、実行中セッションの一括停止と新規実行の
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
  // 停止の失敗は押した場所に出す（`issue-session-status.tsx`の`controlError`と同じ扱い）
  const [error, setError] = useState<string | null>(null);

  const aliveSessions: DispatchSessionView[] = dispatch.sessions.filter(
    (session) => session.state === "ALIVE" && resolveIssueImplementationAgent(session) === agent,
  );
  const pauseReason = dispatch.agentPause[agent];
  // トグルON＝稼働中（一時停止理由が無い）。OFF＝停止中（手動・自動のどちらでも）
  const running = pauseReason === null;

  async function turnOn() {
    setError(null);
    const result = await dispatch.setAgentDispatchPaused({ agent, paused: false });
    if (!result.ok) setError(result.message);
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
        <button
          type="button"
          role="switch"
          aria-checked={running}
          aria-label={`${describeDispatchAgent(agent)}の実行状態`}
          title={running ? "稼働中（押すと停止します）" : "停止中（押すと再開します）"}
          disabled={dispatch.isSubmitting}
          onClick={() => (running ? setConfirming(true) : void turnOn())}
          className={cn(
            "ml-auto inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
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
                  ブロックします。セッション自体は残り、続きから再開できます。オンに戻せばいつでも
                  新規実行を再開できます。
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
    </div>
  );
}
