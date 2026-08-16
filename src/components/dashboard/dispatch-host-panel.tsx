"use client";

import { ExternalLink, Monitor } from "lucide-react";

import { DispatchIssueTitle } from "@/components/dashboard/dispatch-issue-title";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { isDispatchHostAtSessionCapacity } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostCheckout,
  type DispatchHostCheckoutTone,
} from "@/lib/dispatch/host-checkout";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  describeDispatchHostMetrics,
  formatHostMetricPercent,
  type DispatchHostMetricTone,
} from "@/lib/dispatch/host-metrics";
import { summarizeIssueSession, type IssueSessionTone } from "@/lib/dispatch/issue-session";
import { selectHostSessions } from "@/lib/dispatch/queue-summary";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * ホストの様子（セッション本数・リソース使用率・動いているセッション）を1枚にまとめる（#1567）。
 *
 * **従来はセッションの本数（`サブPCのセッション 6/12`）しか出ていなかった。** その6本が何なのかは
 * `tmux ls`かops-dashboardを開くまで分からず、CPU・メモリも同様だったため、「もう1本起こして
 * よいか」を判断するたびにアプリを移ることになっていた。
 *
 * **PCの実行キュー（`dispatch-queue-button.tsx`）とスマホのホーム画面
 * （`mobile/mobile-home-screen.tsx`）が同じものを使う。** 片方だけに置くと、外出先で見たときに
 * 何が動いているのか分からないという元の状態がスマホ側に残る。
 * スマホ側は#1638でいったんヘッダーの実行状況シートへ移したが、ホームを開いても「いま何が
 * 動いているか」が分からなくなったため#1690で戻した。**同じ部品を2か所に置く代わりに、
 * ホームは「ホストの様子と動いているセッション」のサマリ、ヘッダーのシートはそれに加えて
 * キュー全体（順番待ち・失敗・停止操作）**という切り分けにしてある。
 *
 * **セッションの行の文言・配色は`summarizeIssueSession`をそのまま使う**（Issue詳細の
 * `issue-session-status.tsx`と同じ）。ここで独自の言い方を作ると、同じセッションが画面に
 * よって違う状態に見える。
 *
 * **使用率で何かを止めることはしない。** 起動を止めているのはセッション本数の上限（#1361）と
 * 同時実行数だけで、ここは人が判断するための計器（`docs/multi-agent/gates.md`）。
 */

const METRIC_TONE_CLASS: Record<DispatchHostMetricTone, { bar: string; text: string }> = {
  normal: { bar: "bg-muted-foreground/60", text: "text-muted-foreground" },
  warn: { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  critical: { bar: "bg-destructive", text: "text-destructive" },
};

/**
 * チェックアウトの鮮度（#1612）の配色。**使用率と同じ3段階の同じ色**にして、画面の中で
 * 同じ色が違う重さを指さないようにする。
 */
const CHECKOUT_TONE_CLASS: Record<DispatchHostCheckoutTone, string> = {
  normal: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

const SESSION_TONE_CLASS: Record<IssueSessionTone, string> = {
  running: "bg-primary",
  waiting: "bg-amber-500",
  done: "bg-muted-foreground",
  error: "bg-destructive",
};

const SESSION_TEXT_CLASS: Record<IssueSessionTone, string> = {
  running: "text-muted-foreground",
  waiting: "text-amber-700 dark:text-amber-400",
  done: "text-muted-foreground",
  error: "text-destructive",
};

export function DispatchHostPanel({
  hosts,
  sessions,
  onOpenIssue,
}: {
  hosts: readonly DispatchHostView[];
  sessions: readonly DispatchSessionView[];
  /**
   * セッションの行のタイトルから、そのIssueの詳細を開く（#1625）。渡さなければタイトルは
   * ただの文字列のまま（従来の表示）。**Issueのidが引けている行にだけリンクを出す**ので、
   * 押しても何も起きない行は生まれない。
   */
  onOpenIssue?: (issueId: string) => void;
}) {
  if (hosts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {hosts.map((host) => (
        <HostCard
          key={host.name}
          host={host}
          sessions={selectHostSessions(sessions, host.name)}
          onOpenIssue={onOpenIssue}
        />
      ))}
    </div>
  );
}

function HostCard({
  host,
  sessions,
  onOpenIssue,
}: {
  host: DispatchHostView;
  sessions: DispatchSessionView[];
  onOpenIssue?: (issueId: string) => void;
}) {
  const metrics = describeDispatchHostMetrics(host);
  // いま動いているスクリプトがどの版か（#1612）。**pollerは自分と同じチェックアウトの
  // 回収スクリプト・ランチャーを動かすため、developへマージしただけでは効かない。**
  // ここに出しておかないと、効いていないことに気付く手掛かりがどこにも無い
  const checkout = describeDispatchHostCheckout(host);
  const atCapacity = isDispatchHostAtSessionCapacity(host);
  // 申告していない古いpollerでは本数そのものが不明。0本と混ぜない（#1394）
  const hasSessionCount = host.maxSessions !== null && host.liveSessions !== null;

  return (
    <div className="rounded-md border p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              host.online ? "bg-primary" : "bg-muted-foreground",
            )}
          />
          {formatDispatchHostName(host.name)}
        </span>
        {host.online ? (
          hasSessionCount && (
            <span className={cn("text-[11px] text-muted-foreground", atCapacity && "text-destructive")}>
              セッション {host.liveSessions}/{host.maxSessions}
            </span>
          )
        ) : (
          // 応答していないホストは本数も使用率も出さない。最後の申告の時刻だけを出して、
          // 「動いていない」と「見えていない」を取り違えないようにする
          <span className="text-[11px] text-muted-foreground">
            応答していません・{formatRelativeDate(host.lastSeenAt)}
          </span>
        )}
      </div>

      {checkout && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="truncate text-muted-foreground">スクリプト {checkout.version}</span>
          <span className={cn("shrink-0", CHECKOUT_TONE_CLASS[checkout.tone])}>
            {checkout.status}
            {checkout.detail ? `・${checkout.detail}` : ""}
          </span>
        </div>
      )}

      {metrics && (
        <div className="mt-1.5 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
          {metrics.map((metric) => (
            <MetricRow key={metric.label} {...metric} />
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t pt-2">
          {sessions.map((session) => (
            <SessionRow
              key={session.tmuxSessionName}
              session={session}
              onOpenIssue={onOpenIssue}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricRow({
  label,
  percent,
  detail,
  tone,
}: {
  label: string;
  percent: number;
  detail: string | null;
  tone: DispatchHostMetricTone;
}) {
  const toneClass = METRIC_TONE_CLASS[tone];
  return (
    <>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className="h-1.5 rounded-full bg-muted"
        // 数字は右のラベルが読み上げる。目盛りは装飾なので読み上げ対象から外す
        aria-hidden
      >
        <span
          className={cn("block h-full rounded-full", toneClass.bar)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className={cn("text-[11px] tabular-nums", toneClass.text)}>
        {formatHostMetricPercent(percent)}
        {detail ? `・${detail}` : ""}
      </span>
    </>
  );
}

function SessionRow({
  session,
  onOpenIssue,
}: {
  session: DispatchSessionView;
  onOpenIssue?: (issueId: string) => void;
}) {
  const summary = summarizeIssueSession(session);
  const repoName = session.repositoryFullName.split("/")[1] ?? session.repositoryFullName;

  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", SESSION_TONE_CLASS[summary.tone])}
      />
      <span className="min-w-0 flex-1">
        {/*
          タイトルはそのIssueの詳細への導線（#1625）。右のアイコンがRemote Control・開発サーバー
          という**issue-deckの外**へ出る導線なのに対し、こちらはこの画面の中で開く
        */}
        <DispatchIssueTitle
          issueNumber={session.issueNumber}
          issueTitle={session.issueTitle}
          issueId={session.issueId}
          onOpenIssue={onOpenIssue}
        />
        <span className={cn("block truncate", SESSION_TEXT_CLASS[summary.tone])}>
          {repoName}・{summary.shortLabel}・{formatRelativeDate(summary.at)}
        </span>
      </span>
      {/*
        入力待ちのときに答える唯一の出口（#1264）。ここに出しておくと、Issueを開かずに
        キューからそのまま答えに行ける
      */}
      {summary.remoteControlUrl && (
        <a
          href={summary.remoteControlUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Remote Controlを開く"
          aria-label={`#${session.issueNumber}のRemote Controlを開く`}
          className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {/* tailnetへ出した開発サーバー（#1265）。生きているセッションでだけ出る */}
      {summary.previewUrl && (
        <a
          href={summary.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="開発サーバーを開く"
          aria-label={`#${session.issueNumber}の開発サーバーを開く`}
          className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Monitor className="size-3.5" />
        </a>
      )}
    </li>
  );
}
