"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, HandHelping, Loader2, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  summarizeIssueSession,
  type IssueSessionTone,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 起動したセッションの様子を出す（#1264）。
 *
 * **`DispatchJob`の状態表示（`dispatch-job-status.tsx`）が終わるところから先を担当する。**
 * ジョブの寿命は「tmuxセッションが立った」までで、その後セッションが生きているのか・人の入力を
 * 待っているのか・落ちたのかは画面のどこにも出ていなかった。
 *
 * **入力待ちのときはRemote ControlのURLを出す。** これが承認の唯一の出口で、従来はSignalyの
 * 通知の中にしか無く、通知を消すと承認待ちであること自体を知る手段が無くなっていた。
 *
 * 画面から入力そのものは送らない（`docs/multi-agent/gates.md`の禁止事項。`send-keys`で
 * 選択フォームに誤答させた事故がある）。ここが持つのは「開く」までで、答えるのは
 * Remote Control側。
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
  align = "end",
}: {
  session: DispatchSessionView;
  /** 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せ */
  align?: "start" | "end";
}) {
  const summary = summarizeIssueSession(session);

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
      </div>
    </div>
  );
}
