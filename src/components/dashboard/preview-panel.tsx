"use client";

import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MonitorPlay,
  RefreshCw,
  Square,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { copyText } from "@/lib/copy-text";
import type { DispatchHostView, DispatchJobView, PreviewAction } from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  buildPreviewRepositoryRows,
  describePreviewIdleStop,
  describePreviewJob,
  describePreviewRejection,
  selectHostWidePreviewRejection,
  selectPreviewJob,
  type PreviewRepositoryRow,
} from "@/lib/dispatch/preview-server";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 確認環境（#2444）。**developの最新をサブPCで動かし、mainへ出す前の状態を実物の画面で
 * 確かめる**ための1画面。
 *
 * 元は`scripts/start-develop-dev.sh`（#1289）というissue-deck専用のCLIで、Tailscale SSHで
 * 入って叩かないと起こせず、他リポジトリでは使えなかった。**確かめたいのは「mainへ出す前」で、
 * そのとき手元にあるのがスマホであることも多い**ため、画面から押せる形にして全リポジトリへ
 * 広げた（実体は`scripts/start-preview-dev.sh`）。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ）。片方にしか置かないと、外出先で
 * 「いま何が動いているか」が分からないという元の状態がそちらに残る（`dispatch-host-panel.tsx`
 * と同じ切り分け）。
 *
 * **同時に動かせるのは1つ。** サブPCの実効RAMは13Giで、#1523ではIssueごとの開発サーバーの
 * 孤児9本でOOM Killerが発動している。別のリポジトリを選ぶと前のものが止まることを、押す前に
 * 一覧の見出しで言う（止めるのはスクリプト側）。
 */
export function PreviewPanel({
  hosts,
  jobs,
  isLoaded,
  onRequestPreview,
  compact = false,
}: {
  hosts: readonly DispatchHostView[];
  jobs: readonly DispatchJobView[];
  /**
   * ディスパッチの状態を取得し終えたか（#1666・#1810）。**取得前は形を決めない。**
   * `hosts`は取得前も`[]`なので、これを見ないと一瞬「サブPCが居ない」画面が出る。
   */
  isLoaded: boolean;
  /** 確認環境への操作を積む。渡さなければボタンを出さない（`dispatch-host-panel.tsx`と同じ形） */
  onRequestPreview?: (params: {
    hostName: string;
    repositoryFullName: string;
    action: PreviewAction;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** スマホ向けに縮める。リポジトリの行を1行にし、説明文を落とす */
  compact?: boolean;
}) {
  if (!isLoaded) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (hosts.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        サブPCの申告が届いていません。pollerが動いているか確認してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hosts.map((host) => (
        <HostPreview
          key={host.name}
          host={host}
          job={selectPreviewJob(jobs, host.name)}
          onRequestPreview={onRequestPreview}
          compact={compact}
        />
      ))}
    </div>
  );
}

function HostPreview({
  host,
  job,
  onRequestPreview,
  compact,
}: {
  host: DispatchHostView;
  job: DispatchJobView | null;
  onRequestPreview?: (params: {
    hostName: string;
    repositoryFullName: string;
    action: PreviewAction;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  compact: boolean;
}) {
  const [pending, setPending] = useState<PreviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const preview = host.preview;
  const jobRow = describePreviewJob(job, now);
  // 未処理の操作がある間は押せない（同時に動かせるのは1つなので、二重に積むと後から届いた方が
  // 前を上書きする）。`resolvePreviewRejection`と同じ判定を画面でも使う
  const hasQueuedJob = jobRow?.tone === "running";
  const rows = buildPreviewRepositoryRows({ host, hasQueuedJob });
  // リポジトリを選び直しても変わらない理由（#2455）。**行ごとではなくここへ1回だけ出す**——
  // 行に置くと申告しているリポジトリの数だけ同じ文言が並び、押す場所まで書いた文言が
  // リポジトリ名の幅を潰す。スマホ（`compact`）でも出す（行の`title`はタッチでは読めない）
  const hostWideRejection = selectHostWidePreviewRejection(rows);

  async function request(repositoryFullName: string, action: PreviewAction) {
    if (!onRequestPreview) return;
    setPending(action);
    setError(null);
    const result = await onRequestPreview({ hostName: host.name, repositoryFullName, action });
    setPending(null);
    if (!result.ok) setError(result.message);
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <MonitorPlay className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">確認環境</h2>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {formatDispatchHostName(host.name)}
          {host.online ? "" : "（応答なし）"}
        </span>
      </header>

      {!compact && (
        <p className="text-xs text-muted-foreground">
          developの最新をサブPCで動かし、mainへ出す前の状態を実物の画面で確かめます。
          tailnetのURLはスマホからそのまま開けます。
        </p>
      )}

      {/* この画面のどのリポジトリも押せない理由（#2455）。**押す場所まで書いて先頭に出す** */}
      {hostWideRejection && (
        <p
          className="flex items-start gap-1.5 rounded-md bg-amber-500/15 p-2.5 text-xs text-amber-700 ring-1 ring-inset ring-amber-500/40 dark:text-amber-400"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            {describePreviewRejection(hostWideRejection)}
          </span>
        </p>
      )}

      {preview ? (
        <RunningPreview
          host={host}
          compact={compact}
          pending={pending}
          disabled={!onRequestPreview || hasQueuedJob}
          onRefresh={() => request(preview.repository, "refresh")}
          onStop={() => request(preview.repository, "stop")}
        />
      ) : (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          確認環境は動いていません。下の一覧から見たいリポジトリを選ぶと、developの最新で起動します
          （起動には数分かかります）。
        </p>
      )}

      {jobRow && (
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs",
            jobRow.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role="status"
        >
          {jobRow.tone === "running" && (
            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
          )}
          <span className="min-w-0 break-words">{jobRow.text}</span>
        </p>
      )}

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold">リポジトリ</h3>
          <span className="text-[11px] text-muted-foreground">
            同時に動かせるのは1つ。選ぶと今のものは止まります
          </span>
        </div>
        <ul className="divide-y rounded-md border">
          {rows.map((row) => (
            <RepositoryRow
              key={row.repositoryFullName}
              row={row}
              compact={compact}
              // ホスト全体の理由は見出しの下に1回だけ出したので、行では繰り返さない（#2455）
              hideRejectionText={hostWideRejection !== null}
              pending={pending === "start"}
              disabled={!onRequestPreview}
              onStart={() => request(row.repositoryFullName, "start")}
            />
          ))}
          {rows.length === 0 && (
            <li className="p-3 text-xs text-muted-foreground">
              このホストから起動できるリポジトリがありません。
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

function RunningPreview({
  host,
  compact,
  pending,
  disabled,
  onRefresh,
  onStop,
}: {
  host: DispatchHostView;
  compact: boolean;
  pending: PreviewAction | null;
  disabled: boolean;
  onRefresh: () => void;
  onStop: () => void;
}) {
  const preview = host.preview;
  if (!preview) return null;

  const repoName = preview.repository.split("/")[1] ?? preview.repository;
  const idleStop = describePreviewIdleStop(preview);

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex flex-col gap-2 border-b bg-emerald-50 p-3 dark:bg-emerald-950/30">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
          />
          起動中
          {preview.startedAt && ` ・ ${formatRelativeDate(preview.startedAt)}から`}
        </span>
        <span className="text-sm font-semibold">{repoName}</span>
        {/*
          どの時点のdevelopを見ているのか（#1289）。**画面を見ている最中に確かめられること**が
          この機能の要点で、コミットが分からないと「直したはずの画面が古い」の切り分けができない
        */}
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {preview.branch && <span className="font-mono">{preview.branch}</span>}
          {preview.commit && <span className="font-mono">{preview.commit}</span>}
          <span className="min-w-0 break-words">{preview.subject}</span>
        </span>
      </div>

      <div className="flex flex-col divide-y">
        {/*
          **tailnetのURLを先に出す**（#2444）。この画面を見るのはスマホであることも多く、
          `localhost`はサブPCの中でしか開けない
        */}
        <UrlRow
          label="スマホ・別端末"
          url={preview.url}
          emptyNote="tailscale serve が使えないため、このホストからは公開できていません。"
          openable
        />
        <UrlRow label="このPC" url={`http://localhost:${preview.port}`} note="サブPCの中だけ" />
      </div>

      {/*
        **確かめられるのは読み取りの画面だけ**（#2444）。確認環境が動かすのはまだ本番へ出して
        いないコードなので、書き込み系のAPIは`PREVIEW_MODE`で塞いである（開いた先で押しても
        何も起きない）。開く前に言わないと、押しても反応しない画面を不具合として追うことになる
      */}
      <p className="border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
        開けるのは見るための画面までです。ボタンからの書き込み（Issueの更新・マージなど）は
        塞いであり、データも開発用のものです。
      </p>

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || pending !== null}
          onClick={onRefresh}
        >
          {pending === "refresh" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          最新へ更新
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || pending !== null}
          onClick={onStop}
        >
          {pending === "stop" ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Square className="size-3.5" aria-hidden />
          )}
          停止
        </Button>
        {!compact && idleStop && (
          <span className="ml-auto text-[11px] text-muted-foreground">{idleStop}</span>
        )}
      </div>
    </div>
  );
}

function UrlRow({
  label,
  url,
  note,
  emptyNote,
  openable = false,
}: {
  label: string;
  url: string | null;
  note?: string;
  emptyNote?: string;
  openable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  if (!url) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground">
        <span className="font-semibold">{label}</span>
        <span className="ml-2">{emptyNote}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 p-2">
      <span className="w-24 shrink-0 text-[11px] font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
        {url}
      </span>
      {note && <span className="shrink-0 text-[11px] text-muted-foreground">{note}</span>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`${label}のURLをコピー`}
        onClick={async () => {
          // **コピーできたときだけ成功表示を出す**（`copy-text.ts`）。tailnet経由（http）では
          // `navigator.clipboard`が生えないため、落ちる経路が実際にある
          if (await copyText(url)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </Button>
      {openable && (
        <Button asChild type="button" size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3.5" aria-hidden />
            開く
          </a>
        </Button>
      )}
    </div>
  );
}

function RepositoryRow({
  row,
  compact,
  hideRejectionText,
  pending,
  disabled,
  onStart,
}: {
  row: PreviewRepositoryRow;
  compact: boolean;
  /** ホスト全体の理由として見出しの下に出し済みか（#2455）。行では繰り返さない */
  hideRejectionText: boolean;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <li className="flex items-center gap-2 p-2 text-xs">
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          row.running && "font-semibold",
          row.noDevServer && "text-muted-foreground",
        )}
      >
        {row.name}
      </span>
      {row.running ? (
        <span className="shrink-0 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
          起動中
        </span>
      ) : row.noDevServer ? (
        /*
          開発サーバーを持たないリポジトリ（vps・subpc・docs・claude-config・ideas）。
          **一覧から消さずに理由を添える**——消すと「vpsはなぜ無いのか」が分からず、
          確認環境で見られないことと、サブPCにチェックアウトが無いことの区別も付かない
        */
        <span className="shrink-0 text-[11px] text-muted-foreground">開発サーバーがありません</span>
      ) : (
        <>
          {/*
            押せない理由は**押す前に出す**（`describePreviewRejection`）。押した先で
            `failed`のジョブだけが返る形にしない
          */}
          {row.rejection && !compact && !hideRejectionText && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {describePreviewRejection(row.rejection)}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={disabled || pending || row.rejection !== null}
            title={row.rejection ? describePreviewRejection(row.rejection) : undefined}
            onClick={onStart}
          >
            {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {compact ? "切り替え" : "ここに切り替える"}
          </Button>
        </>
      )}
    </li>
  );
}
