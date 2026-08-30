"use client";

import { AlertTriangle, Ban, Check, CheckCircle2, Clock, Copy, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_DISPATCH_AGENT,
  describeDispatchAgent,
  describeDispatchJobStatus,
  isCancelableDispatchJobStatus,
  type DispatchJobTone,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/**
 * サブPCへ積んだジョブの状態表示（#1180）。
 *
 * **pull型なので、押してから起動が始まるまでに最大でポーリング間隔（既定30秒）かかる**
 * （[docs/multi-agent/subpc-dispatch.md](../../../docs/multi-agent/subpc-dispatch.md)）。
 * その間に画面が何も変わらないと「押しても何も起きていない」ようにしか見えないため、
 * 順番待ち・起動中・失敗をここに出す。失敗理由（`message`）はホバーではなく本文として出す
 * （**主な用途が外出先のスマホ**で、ホバーが無い）。
 *
 * 配色はCI状態のピル（`pull-request-badges.tsx`の`CiStateBadge`）に揃えている。
 *
 * **時刻は相対表現ではなく具体的な日時で出す**（#1468）。「3時間前」では、手元のtmuxで動いている
 * セッションと突き合わせられない。
 *
 * **`tmux attach`のコマンドは行として置かず、状態のピルをクリックしてコピーさせる**（#1468）。
 * 常時見えていても読むものではなく、ヘッダーの行数を1行消費するだけだった。
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
  const [copied, setCopied] = useState(false);
  // 種別を必ず渡す。省略すると起動ジョブ扱いになり、種別が増えたときに文言が黙って
  // 「起動しました」になる（#1294）
  const { label, tone } = describeDispatchJobStatus(job.status, job.kind);
  // 状態ごとに「いつの話か」を示す時刻は変わる。終わっていれば終了時刻、動いていれば開始時刻
  const timestamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const textAlign = align === "end" ? "text-right" : "text-left";
  // 起動できたセッションの中身を見る唯一の手掛かり（Actions UIに相当するものが無い）。
  // 行として常時出す代わりに、ピルのクリックでコピーさせる（#1468）
  const attachCommand =
    job.status === "SUCCEEDED" && job.tmuxSessionName
      ? `tmux attach -t ${job.tmuxSessionName}`
      : null;

  async function handleCopyAttachCommand() {
    if (!attachCommand) return;
    try {
      await navigator.clipboard.writeText(attachCommand);
    } catch {
      // クリップボードが使えない環境（権限拒否・非セキュアコンテキスト）では、コピーできて
      // いないのに成功表示を出さない（`start-implementation-dialog.tsx`と同じ扱い）
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const pillClassName = cn(
    "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ring-inset",
    TONE_CLASS[tone],
  );
  const pillBody = (
    <>
      {copied ? <Check className="size-3.5" /> : <ToneIcon tone={tone} />}
      {formatDispatchHostName(job.targetHost)}で{label}
      {attachCommand && !copied && <Copy className="size-3 opacity-60" />}
    </>
  );

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {attachCommand ? (
        <button
          type="button"
          onClick={() => void handleCopyAttachCommand()}
          className={cn(pillClassName, "cursor-pointer hover:opacity-80")}
          // コマンドそのものはtitleにも出さない（#1468）。画面に出す必要が無いから消した文字列を
          // ホバーで戻すことになる。押せばコピーできると分かれば足りる
          title="クリックでtmuxのアタッチコマンドをコピー"
        >
          {pillBody}
        </button>
      ) : (
        <span className={pillClassName}>{pillBody}</span>
      )}
      {/* 既定以外のエージェントで起こしたことを、ダイアログを閉じた後も出す（#2505）。
          **既定（Claude Code）には印を付けない**——すべての行にラベルが付くと、どれが普通と
          違うのかが読めなくなる。Codexにはフックが無く通知が飛ばないため、待っている人が
          「動いていない」と取り違えないための手掛かりになる */}
      {job.kind === "LAUNCH" && job.agent !== DEFAULT_DISPATCH_AGENT && (
        <span
          className="inline-flex w-fit items-center rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-inset ring-amber-500/40 dark:text-amber-400"
          title="入力待ちの通知・計画の承認・Remote Controlは効きません"
        >
          {describeDispatchAgent(job.agent)}
        </span>
      )}
      {copied && <span className="text-muted-foreground">コピーしました</span>}
      <span className="text-muted-foreground" title={formatDateTimeFull(timestamp)}>
        {formatDateTime(timestamp)}
      </span>
      {isCancelableDispatchJobStatus(job.status) && (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
          取り消し
        </Button>
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
