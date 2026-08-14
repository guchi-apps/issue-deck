"use client";

import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  describeDispatchJobStatus,
  isCancelableDispatchJobStatus,
  type DispatchJobTone,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * サブPCへ積んだジョブの状態表示（#1180）。
 *
 * **pull型なので、押してから起動が始まるまでに最大でポーリング間隔（既定60秒）かかる**
 * （[docs/multi-agent/subpc-dispatch.md](../../../docs/multi-agent/subpc-dispatch.md)）。
 * その間に画面が何も変わらないと「押しても何も起きていない」ようにしか見えないため、
 * 順番待ち・起動中・失敗をここに出す。失敗理由（`message`）はホバーではなく本文として出す
 * （**主な用途が外出先のスマホ**で、ホバーが無い）。
 *
 * 配色はCI状態のピル（`pull-request-badges.tsx`の`CiStateBadge`）に揃えている。
 */

const TONE_CLASS: Record<DispatchJobTone, string> = {
  pending: "bg-primary/15 text-primary ring-primary",
  running: "bg-primary/15 text-primary ring-primary",
  success: "bg-muted text-muted-foreground ring-border",
  error: "bg-destructive/15 text-destructive ring-destructive",
  muted: "bg-muted text-muted-foreground ring-border",
};

function ToneIcon({ tone }: { tone: DispatchJobTone }) {
  const className = "size-3.5";
  switch (tone) {
    case "pending":
      return <Clock className={className} />;
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "success":
      return <CheckCircle2 className={className} />;
    case "error":
      return <AlertTriangle className={className} />;
    case "muted":
      return <Ban className={className} />;
  }
}

export function DispatchJobStatus({
  job,
  onCancel,
  isSubmitting,
  align = "end",
  waitReason = null,
}: {
  job: DispatchJobView;
  onCancel: () => void;
  isSubmitting: boolean;
  /** 横並びのツールバー（PC）では右寄せ、縦積みの詳細画面（スマホ）では左寄せ */
  align?: "start" | "end";
  /**
   * 順番待ちのまま進まない理由（#1394）。**「順番待ち」だけでは、正常に上限で待っているのか
   * pollerが落ちているのかが区別できない。** 判定は`describeDispatchJobWaitReason`が持つ。
   */
  waitReason?: string | null;
}) {
  // 種別を必ず渡す。省略すると起動ジョブ扱いになり、種別が増えたときに文言が黙って
  // 「起動しました」になる（#1294）
  const { label, tone } = describeDispatchJobStatus(job.status, job.kind);
  // 状態ごとに「いつの話か」を示す時刻は変わる。終わっていれば終了時刻、動いていれば開始時刻
  const timestamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const textAlign = align === "end" ? "text-right" : "text-left";

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      <span
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ring-inset",
          TONE_CLASS[tone],
        )}
      >
        <ToneIcon tone={tone} />
        {job.targetHost}で{label}
      </span>
      <span className="text-muted-foreground">{formatRelativeDate(timestamp)}</span>
      {isCancelableDispatchJobStatus(job.status) && (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
          取り消し
        </Button>
      )}
      {/* 起動できたセッションの中身を見る唯一の手掛かり（Actions UIに相当するものが無い） */}
      {job.status === "SUCCEEDED" && job.tmuxSessionName && (
        <code className={cn("w-full break-all text-muted-foreground", textAlign)}>
          tmux attach -t {job.tmuxSessionName}
        </code>
      )}
      {job.message && (tone === "error" || job.status === "CANCELED") && (
        <p className={cn("w-full break-words text-muted-foreground", textAlign)}>{job.message}</p>
      )}
      {/* 失敗ではないので配色は本文のまま。押した人が待ち時間の理由を読めればよい（#1394） */}
      {waitReason && (
        <p className={cn("w-full break-words text-muted-foreground", textAlign)}>{waitReason}</p>
      )}
    </div>
  );
}
