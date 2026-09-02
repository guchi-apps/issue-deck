"use client";

import { Check, Copy, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  describeCodexPairingJob,
  describeCodexPairingRejection,
  formatCodexPairingCountdown,
  resolveCodexPairingRejection,
  type CodexPairingTone,
} from "@/lib/dispatch/codex-pairing";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { cn } from "@/lib/utils";

/**
 * CodexのRemote Control相当（#2524）。ペアリングコードを発行するボタンと、出てきたコード。
 *
 * **押せる場所が2つある**（#2537）。ホストのカード（実行キュー）と、Codexで動いている
 * Issueのセッション表示。**出るものも送るものも同じ**（宛先はホスト名で、Issueには
 * 紐づかない）ため、置き場所ごとに書き分けず、この1つを両方から呼ぶ。
 *
 * - **`RebootRow`・`SelfUpdateRow`と同じ組み立て**（ボタン＋その下に結果の1行）にしてあるが、
 *   **出てくるものが違う**——ここに出るのは結果の文ではなく、押した人が別の端末へ打ち込む
 *   `XXXX-XXXX`のコードそのもの。そのため等幅で大きく出し、コピーのボタンと残り時間を添える
 * - **コードは資格情報。** 期限（10分）を過ぎたものは`describeCodexPairingJob`が返さないので、
 *   ここには出ない。押した人のブラウザの外（Issueコメント・通知・pollerのログ）へは出さない
 * - **繋がる先はホストごと。** 1枚のコードで、そのホストで走っているCodexのセッションが
 *   全部見える（`serverName`はホスト名で、Issueごとには分かれない）。押す前にその旨を出す
 */
export type CodexPairingContext = "host" | "issue";

const TONE_CLASS: Record<CodexPairingTone, string> = {
  normal: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

/**
 * 押す前に出す「どこへ繋がるのか」。**置き場所で言い方を変える。**
 *
 * ホストのカードは対象がホストであることが見出しから分かるが、Issueの画面では
 * **押したIssueだけに繋がると誤解させる**（#2524がボタンをホストのカードに置いた理由がこれ）。
 * Issue側ではそこを先に言う。
 */
function pairingHint(context: CodexPairingContext, hostName: string): string {
  const label = formatDispatchHostName(hostName);
  return context === "issue"
    ? `このIssueだけでなく、ChatGPTアプリから${label}のCodexセッション全部に繋がります`
    : `ChatGPTアプリから${label}のCodexセッション全部に繋がります`;
}

export function CodexPairingControl({
  host,
  job,
  onRequestCodexPairing,
  context = "host",
  align = "end",
  className,
}: {
  host: DispatchHostView;
  job: DispatchJobView | null;
  onRequestCodexPairing: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** どこに置いているか。**文言とボタンの大きさだけが変わる**（送るものは同じ） */
  context?: CodexPairingContext;
  align?: "start" | "end";
  className?: string;
}) {
  const hostName = host.name;
  const [sending, setSending] = useState(false);
  // 積めなかった理由（`RebootRow`と同じ）。**次に押すまで残す**（消えると押した結果が無かったことになる）
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 残り時間を数え直すための現在時刻（#2524）。**ポーリングの間隔に任せない。**
  // ジョブが終わるとキューのポーリングは20秒間隔（`IDLE_POLL_INTERVAL_MS`）へ落ちるため、
  // そのままだとカウントダウンが20秒刻みで飛び、**切れたコードが最大20秒残る**
  const [now, setNow] = useState(() => Date.now());

  const result = describeCodexPairingJob(job, new Date(now));
  const pending = sending || (result?.pending ?? false);
  const rejection = resolveCodexPairingRejection({ host, hasQueuedJob: pending });
  const disabled = pending || rejection !== null;
  const code = result?.code ?? null;
  const countdown = formatCodexPairingCountdown(result?.expiresInSeconds ?? null);
  const notice = error
    ? { label: error, tone: "critical" as CodexPairingTone }
    : result
      ? { label: result.label, tone: result.tone }
      : rejection
        ? { label: describeCodexPairingRejection(rejection, hostName), tone: "warn" as const }
        : null;

  // **コードが出ている間だけ回す。** 出ていなければ数えるものが無く、無駄に再描画するだけ
  const counting = code !== null;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [counting]);

  async function request() {
    setSending(true);
    setError(null);
    setCopied(false);
    try {
      const res = await onRequestCodexPairing(hostName);
      if (!res.ok) setError(res.message);
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // クリップボードが使えない環境（httpのLAN越しなど）では、コードは目で読める場所に
      // 出ているので何もしない。押せなかったことを理由として出すほどのことではない
    }
  }

  const compact = context === "host";
  const alignEnd = align === "end";

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        // ホストのカードでは従来の見た目を変えない（#2524のまま）。Issueの画面では
        // 隣の「Claude Codeアプリで開く」と同じ幅で並べる
        compact ? "mt-1.5" : "w-full",
        alignEnd ? "items-end" : "items-start",
        className,
      )}
    >
      <Button
        variant="outline"
        size="sm"
        className={cn(compact && "h-7 text-[11px]")}
        disabled={disabled}
        onClick={() => void request()}
      >
        {pending ? (
          <Loader2 className={cn("animate-spin", compact && "size-3")} />
        ) : (
          <Smartphone className={cn(compact && "size-3")} />
        )}
        Codexに繋ぐ
      </Button>

      {/* 出てきたコード。**押した人がこれを別の端末へ打ち込む**ので、行の中で最も読みやすくする */}
      {code && (
        <div className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
          <span className="font-mono text-sm font-semibold tracking-widest tabular-nums">
            {code}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {countdown && <span className="text-[11px] text-muted-foreground">{countdown}</span>}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => void copy()}
              aria-label="ペアリングコードをコピー"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </Button>
          </span>
        </div>
      )}

      {notice && (
        <span
          className={cn(
            "text-[11px]",
            alignEnd ? "text-right" : "text-left",
            TONE_CLASS[notice.tone],
          )}
        >
          {notice.label}
        </span>
      )}

      {/* **繋がる先を押す前に出す。** Issueごとに分かれないことは、コードを見てからでは分からない */}
      {!code && !notice && (
        <span
          className={cn(
            "text-[11px] text-muted-foreground",
            alignEnd ? "text-right" : "text-left",
          )}
        >
          {pairingHint(context, hostName)}
        </span>
      )}
    </div>
  );
}
