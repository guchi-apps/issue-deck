"use client";

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  Keyboard,
  Loader2,
  Pencil,
  ScrollText,
  TriangleAlert,
} from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { SESSION_PLAN_REVISION_MAX_LENGTH } from "@/lib/dispatch/session-plan-request";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * ローカルセッションが提示した計画を読んで、その場で承認・修正を送るパネル（#2061）。
 *
 * **これまで、計画の承認・修正はRemote Controlからしか送れなかった。** 計画はIssueコメントに
 * 残る（#1342）ので読むことはできたが、画面に出ていたのは
 * 「承認・修正はRemote Controlから伝えてください」という案内だけ（`LocalSessionWaitingInputNotice`）で、
 * スマホから承認するにも一度Remote Controlを開いてTUIを操作する必要があった。
 *
 * **端末へキーを送る経路（`send-keys`）は持たない。** ここが押された内容はサーバーの
 * `SessionPlanRequest`に入り、計画を出した`PreToolUse(ExitPlanMode)`フックがそれを受け取って
 * Claude Code自身の許可判定として返す（`src/lib/dispatch/session-plan-request.ts`）。
 * 選択フォームに答えさせる操作はどこにも無いので、
 * [docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)の禁止に触れない。
 *
 * **押せない状態でもボタンを消さずに理由を出す**（起動ボタン・代行実行と同じ作法）。
 * 待ち時間が切れた・セッションが終了した、のどちらなのかが分からないと、人は次に
 * どこで答えればよいかを判断できない。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-run-panel.tsx`と同じ方針）。
 * ボタンはスマホで縦積み・全幅になる。
 */

/** 折り畳んだときに見せる高さ。計画は30〜40行が目安なので、要約が読み切れるくらいに取る */
const COLLAPSED_PLAN_CLASS = "max-h-72 overflow-hidden";

export function PlanApprovalPanel({
  request,
  session,
  dispatch,
}: {
  request: SessionPlanRequestView;
  /** 計画を出したセッション。見つかっていなければ`null` */
  session: DispatchSessionView | null;
  dispatch: DispatchStateHandle;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 押した結果は**どの計画に対して押したのか**まで持つ（#2158）。`"approve"`だけを覚えると、
  // 別の計画に差し替わってもその表示が残り、**押していない計画に「承認を送りました」が出る**
  // （Issue詳細はIssueを切り替えてもマウントされたままで、計画を出し直したときも同じ）
  const [sent, setSent] = useState<{
    requestId: string;
    decision: "approve" | "revise" | "defer";
  } | null>(null);

  // 押した結果はカウントダウンと同じ1秒刻みで見せる。**返事はサーバーに入っているので、
  // 画面のポーリングが追い付く前でも「送った」ことは確定している**
  const remainingMs = useRemainingMs(request.expiresAt);

  const hostLabel = request.hostName ? formatDispatchHostName(request.hostName) : "ローカル";
  const sessionGone = session !== null && session.state !== "ALIVE";
  // 「ここからは送れない」と言うだけでは、どこで答えればよいのかが画面から辿れない（#2108）
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  async function send(decision: "approve" | "revise" | "defer") {
    setError(null);
    const result = await dispatch.decidePlan({
      id: request.id,
      decision,
      text: decision === "revise" ? revision : undefined,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent({ requestId: request.id, decision });
    setIsRevising(false);
  }

  // 送った直後、または他の経路（フックの受け取り・期限切れ）で決まった後の表示。
  // **押した本人が「効いたのか」を確かめられれば足りる**ので、結果だけを出して枠を畳む。
  // **いま出ている計画に対して押したものだけを見る**（#2158。別の計画の結果は持ち越さない）
  const sentForThisRequest = sent?.requestId === request.id ? sent.decision : null;
  const decided = sentForThisRequest ?? decisionOf(request.status);
  if (decided) {
    return (
      <PlanDecisionResult
        decision={decided}
        hostLabel={hostLabel}
        remoteControlUrl={remoteControlUrl}
      />
    );
  }

  const canSend = !sessionGone && remainingMs > 0;

  return (
    <section className="overflow-hidden rounded-md border border-amber-500/50 bg-card">
      <header className="flex items-start gap-2.5 border-b border-amber-500/50 bg-amber-500/10 p-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/80 text-amber-950">
          <ScrollText className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            計画の承認を待っています
          </h3>
          <p className="text-xs text-muted-foreground">
            {hostLabel}のセッションが{formatRelativeDate(request.createdAt)}に提示しました
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-medium tabular-nums text-amber-700 dark:text-amber-400">
            {formatRemaining(remainingMs)}
          </div>
          <div className="text-[10px] text-muted-foreground">あと</div>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3">
        <div className="relative rounded-md border bg-muted/60 px-3 py-2">
          <div className={isExpanded ? undefined : COLLAPSED_PLAN_CLASS}>
            <MarkdownBody content={request.plan} repositoryFullName={request.repositoryFullName} />
          </div>
          {!isExpanded && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">
              <Button variant="outline" size="sm" onClick={() => setIsExpanded(true)}>
                <ChevronDown />
                全文を表示
              </Button>
            </div>
          )}
        </div>

        {isRevising ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium" htmlFor={`plan-revision-${request.id}`}>
              修正してほしいこと
            </label>
            <Textarea
              id={`plan-revision-${request.id}`}
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              maxLength={SESSION_PLAN_REVISION_MAX_LENGTH}
              rows={4}
              placeholder="どこを・なぜ・どう直してほしいかを書いてください。この文がそのままClaudeへ渡ります。"
            />
            {/* **アーティファクトの直しもここから頼める**（#2200）。承認前は「計画の直し」しか
                送れないと読めてしまい、見た目の指摘だけRemote Controlへ回されていた */}
            <p className="text-[11px] text-muted-foreground">
              アーティファクト（見た目）の直しもここから頼めます。承認前でも、下の「アーティファクト」
              カードが新しい見た目に差し替わります。
            </p>
            {/* 定型文は**差し込むだけ**で押すのは人（追加指示・#1012と同じ作法）。
                送る前に手直しできる形にしておく */}
            <div className="flex flex-wrap gap-1.5">
              {REVISION_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setRevision((prev) => (prev ? `${prev}\n${preset}` : preset))}
                >
                  {preset}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {revision.length} / {SESSION_PLAN_REVISION_MAX_LENGTH}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsRevising(false)}>
                  やめる
                </Button>
                <Button
                  size="sm"
                  disabled={!canSend || dispatch.isSubmitting || revision.trim().length === 0}
                  onClick={() => void send("revise")}
                >
                  {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <Pencil />}
                  修正を送る
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              size="sm"
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => void send("approve")}
            >
              {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <Check />}
              承認して実装へ進む
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => setIsRevising(true)}
            >
              <Pencil />
              修正を送る
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => void send("defer")}
            >
              <Keyboard />
              端末・Remote Controlで答える
            </Button>
          </div>
        )}

        {sessionGone && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            このセッションは終了しています。承認・修正は届きません。続きを頼むには
            「セッションを復旧」から起こし直してください。
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          承認するとセッションはこの計画のまま実装に入ります。押した内容はIssueコメントにも残ります。
          待ち時間が切れると端末に従来どおりの承認プロンプトが出て、ここからは送れなくなります。
        </p>
      </div>
    </section>
  );
}

/**
 * 押した定型文（#2061）。**押すのは人**で、状況を見て自動で選ぶ実行体は作らない
 * （`docs/multi-agent/gates.md`）。入力欄へ差し込むだけで、送るのは別の操作。
 */
const REVISION_PRESETS = [
  "計画が大きすぎます。サブIssueへの分割を検討してください。",
  "懸念点をもう少し具体的に書いてください。",
  // 定型文のうち**これだけは書き足してもらう前提**（#2200）。どこをどう直すかは毎回違うが、
  // 「アーティファクトを直してよい」こと自体が伝わっていないのが元の詰まりだった
  "アーティファクトの見た目を直してください（直す箇所をこの下に書きます）:",
] as const;

function PlanDecisionResult({
  decision,
  hostLabel,
  remoteControlUrl,
}: {
  decision: "approve" | "revise" | "defer" | "expired";
  hostLabel: string;
  /** 端末で答えることになったときの行き先。無ければリンクを出さない */
  remoteControlUrl: string | null;
}) {
  const tone =
    decision === "approve"
      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : decision === "defer" || decision === "expired"
        ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border bg-muted text-muted-foreground";

  const answerElsewhere = decision === "defer" || decision === "expired";

  return (
    <section className={`flex flex-col gap-2 rounded-md border p-3 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {decision === "approve" ? (
            <ClipboardCheck className="size-3.5" aria-hidden />
          ) : decision === "revise" ? (
            <Pencil className="size-3.5" aria-hidden />
          ) : (
            <Keyboard className="size-3.5" aria-hidden />
          )}
        </span>
        <span className="leading-relaxed">
          {decision === "approve" && (
            <>
              <strong className="font-semibold">承認を送りました。</strong>
              {hostLabel}のセッションが実装に入ります。この結果はIssueコメントにも残しました。
            </>
          )}
          {decision === "revise" && (
            <>
              <strong className="font-semibold">修正を送りました。</strong>
              計画を練り直しています。新しい計画が出たら、またここに出ます。
            </>
          )}
          {answerElsewhere && (
            <>
              <strong className="font-semibold">端末に承認プロンプトを出しました。</strong>
              ここからは送れません。Remote Controlか
              <code className="mx-1 rounded bg-background/60 px-1 py-0.5 font-mono">tmux attach</code>
              で答えてください。
            </>
          )}
        </span>
      </div>
      {answerElsewhere && remoteControlUrl && (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <a href={remoteControlUrl} target="_blank" rel="noreferrer">
            Remote Controlで答える
            <ExternalLink />
          </a>
        </Button>
      )}
    </section>
  );
}

function decisionOf(
  status: SessionPlanRequestView["status"],
): "approve" | "revise" | "defer" | "expired" | null {
  switch (status) {
    case "APPROVED":
      return "approve";
    case "REVISION_REQUESTED":
      return "revise";
    case "DEFERRED":
      return "defer";
    case "EXPIRED":
      return "expired";
    case "WAITING":
      return null;
  }
}

/**
 * 残り時間（ms）。**1秒ごとに描き直す。**
 *
 * 状態のポーリングは5秒間隔で、そこに合わせると数字が飛んで「動いていない」ように見える。
 * 期限そのものはサーバーが持っている（`expiresAt`）ので、ここは表示だけを進める。
 */
function useRemainingMs(expiresAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timerId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, []);
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
