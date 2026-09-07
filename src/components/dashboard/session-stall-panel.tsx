"use client";

import { useId, useState } from "react";
import { ExternalLink, Loader2, PlugZap, SendHorizonal, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  parseSessionInstruction,
  SESSION_INSTRUCTION_MAX_LENGTH,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import { describeSessionStall } from "@/lib/dispatch/session-stall";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * 停滞したローカルセッションを、この画面から復旧させるパネル（#2886）。
 *
 * **これまで、停滞からの復旧はRemote Controlか`tmux attach`でしか行えなかった。**
 * `supervisor:session-*`の引き上げ（#1971・#2655・#2844）はIssueコメントと`00.check-user`に
 * しか残らず、送るべき復旧文面はコメント本文のコードブロックとして書かれているだけだった。
 * 実際に困った事例が guchi-apps/research-desk#118 で、最初の段階で止まったセッションを
 * 動かすためにClaude Codeアプリを開くことになった。
 *
 * **送るのは`session-stall.ts`が持つ固定文面で、押すのは人。** 状況を読んで文面を組み立てる
 * 実行体はどこにも無く、送出は既存の追加指示（#1012）の3段階プロトコルをそのまま通る
 * （承認プロンプト・選択フォームの表示中は見送られる）。したがって
 * [docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)の例外2の内側で、
 * 答えを選ばせる操作（選択肢の確定）は引き続きこの画面から行わない。
 *
 * **自由入力も同じ枠に置く。** 固定文面で解けない停滞（クラシファイアの拒否など）で
 * 「では別の場所で書いてください」と追い出すと、画面で完結しないままになる。こちらは
 * 従来の追加指示（`sendSessionControl`）へそのまま流すので、**確認待ちは外れない**
 * （外れるのは固定文面を押したときだけ）。
 *
 * **押せない理由は押す前に出し、ボタンごと消さない**（`SessionRecoveryButton`・停止と同じ作法）。
 */
export function SessionStallPanel({
  session,
  dispatch,
}: {
  /** そのIssueのセッション。見つかっていなければ呼び出し側が`null`を渡す */
  session: DispatchSessionView | null;
  dispatch: DispatchStateHandle;
}) {
  const inputId = useId();
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 送った本文をそのまま覚える（#1012の「何を送ったのかを出す」と同じ）。届くまで最大1分
  // あるので、これが無いと送り直してよいのか判断できない
  const [sent, setSent] = useState<string | null>(null);

  const stall = session ? describeSessionStall(session) : null;
  // `describeSessionStall`が返した時点で`interruptedAt`は必ず入っている（読めない時刻は
  // あちらがnullへ倒す）が、型の上では`null`のままなので受け取り直す
  const interruptedAt = session?.interruptedAt ?? null;
  if (!session || !stall || !interruptedAt) return null;

  const hostLabel = formatDispatchHostName(session.host);
  const remoteControlUrl = summarizeIssueSession(session).remoteControlUrl;
  const instructionBody = parseSessionInstruction(instruction);

  async function sendRecovery(body: string) {
    if (!session) return;
    setError(null);
    const result = await dispatch.sendSessionRecovery({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      body,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent(body);
    // **ここで確認待ちが外れたことにしない**（#2886のG1レビュー）。送出は非同期で、
    // 承認プロンプトの表示中・作業中・入力欄に打ちかけがある場合はpollerが見送る。
    // 外れるのは`succeeded`の報告が届いた時点（`POST /api/dispatch/report`）で、画面には
    // 次のIssueの取得で反映される。`PlanApprovalPanel`が押した直後に外すのは、あちらの
    // 返事がその場でDBに入って必ずセッションへ届くから
  }

  async function sendInstruction(body: string) {
    if (!session) return;
    setError(null);
    const result = await dispatch.sendSessionControl({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      kind: "instruction",
      instruction: body,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent(body);
    setInstruction("");
  }

  return (
    <section className="overflow-hidden rounded-md border border-destructive/50 bg-card">
      <header className="flex items-start gap-2.5 border-b border-destructive/50 bg-destructive/10 p-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-destructive/80 text-destructive-foreground">
          <TriangleAlert className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="text-sm font-semibold text-destructive">{stall.title}</h3>
          <p className="text-xs text-muted-foreground">
            {hostLabel}のセッションが{formatRelativeDate(interruptedAt)}から止まっています
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3">
        {stall.detail.map((paragraph) => (
          <p key={paragraph} className="text-xs break-words text-muted-foreground">
            {paragraph}
          </p>
        ))}

        {/* 固定文面（#2886）。**押すのは人で、文面は`session-stall.ts`が持つ。**
            差し込むだけの定型文（追加指示のプリセット）と違って直接送るのは、これが
            「原因ごとに決まっている復旧の文面」で、手直しする余地がそもそも無いため */}
        <div className="flex flex-col gap-2">
          {stall.presets.map((preset) => (
            <Button
              key={preset.body}
              variant="default"
              size="sm"
              className="w-full sm:w-auto"
              disabled={dispatch.isSubmitting}
              onClick={() => void sendRecovery(preset.body)}
            >
              {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {preset.label}
            </Button>
          ))}
        </div>

        {/* 何を送るのかは押す前に全文を出す（手作業の代行実行と同じ作法）。押した後に
            「何が届いたのか」を確かめる先にもなる */}
        <details className="rounded-md border bg-muted/60 px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            送られる文面を確認する
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {stall.presets.map((preset) => (
              <p
                key={preset.body}
                className="rounded bg-background px-2 py-1.5 font-mono text-[11px] break-words"
              >
                {preset.body}
              </p>
            ))}
          </div>
        </details>

        {/* 自由入力（#1012の追加指示へそのまま流す）。**確認待ちは外れない**ので、
            そのことも書いておく——押したのに印が残る／消えるのが操作ごとに違うのは、
            画面から読み取れないと分からない */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" htmlFor={inputId}>
            自分で書いて送る
          </label>
          <div className="flex w-full gap-2">
            <Input
              id={inputId}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!instructionBody) return;
                void sendInstruction(instructionBody);
              }}
              maxLength={SESSION_INSTRUCTION_MAX_LENGTH}
              placeholder="セッションへ送る指示（1行）"
              aria-label="復旧の指示（自由入力）"
              disabled={dispatch.isSubmitting}
            />
            <Button
              size="sm"
              disabled={instructionBody === null || dispatch.isSubmitting}
              onClick={() => {
                if (!instructionBody) return;
                void sendInstruction(instructionBody);
              }}
            >
              <SendHorizonal />
              送信
            </Button>
          </div>
          <p className="text-[11px] break-words text-muted-foreground">
            こちらは通常の追加指示として届きます（改行は送れません・
            {SESSION_INSTRUCTION_MAX_LENGTH}文字まで）。
            <strong className="font-medium">確認待ちの印は外れません</strong>
            ——外れるのは、上の固定文面がセッションへ届いたときだけです。
          </p>
        </div>

        {sent && (
          <p className="text-xs break-words text-muted-foreground">
            「{sent}」を送信しました。届くまで最大1分ほどかかります。
            <strong className="font-medium">届いたかどうかは上のセッションの行に出ます</strong>
            ——承認プロンプト・選択フォームが出ている間は送らずに見送られ、その場合は確認待ちの
            印も残ります。動き出さなければもう一度押すか、下の「Claude Codeアプリで開く」から
            続けてください。
          </p>
        )}
        {error && <p className="text-xs break-words text-destructive">{error}</p>}

        {/* 出口は残す（#1676「入力待ちのときの唯一の出口は畳まない」と同じ立場）。
            固定文面で解けない停滞では、ここが最後の手段になる */}
        {remoteControlUrl && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={remoteControlUrl} target="_blank" rel="noreferrer">
                Claude Codeアプリで開く
                <ExternalLink />
              </a>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
