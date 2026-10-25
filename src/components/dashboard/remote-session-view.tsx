"use client";

import { ExternalLink, Loader2, RotateCcw, Search, Star, TerminalSquare } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useRemoteSessions, type RemoteSessionLaunch } from "@/hooks/use-remote-sessions";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  describeRemoteSessionStatus,
  isRemoteSessionResumable,
  REMOTE_SESSION_REPOSITORY_PARAM,
  type RemoteSessionState,
  type RemoteSessionView as RemoteSession,
} from "@/lib/dispatch/remote-session-rules";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";
import type { ConnectedRepository } from "@/types/repository";

/** 「終了したセッション」に並べる件数。古いものは一覧（7日）から自然に落ちる */
const HISTORY_LIMIT = 5;

const DESCRIPTION = "リポジトリを選ぶと、サブPCでClaude Codeのセッションを立ち上げてClaude Codeアプリで開きます。";

/** 起動先として選べるリポジトリ。ホストの申告が読めるまでは`dispatchRunnable`で代える */
export function runnableRepositories(state: RemoteSessionState | null, repositories: ConnectedRepository[]): Set<string> {
  if (!state) return new Set(repositories.filter((repo) => repo.dispatchRunnable).map((repo) => repo.fullName));
  return new Set(state.hosts.filter((host) => host.remoteSessionCapable).flatMap((host) => host.repositories));
}

function isActive(session: RemoteSession): boolean {
  return ACTIVE_REMOTE_SESSION_STATUSES.includes(session.status);
}

function StatusBadge({ session }: { session: RemoteSession }) {
  const tone =
    session.status === "running"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : session.status === "starting"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : session.status === "failed"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("border-transparent", tone)}>
      {session.stopping ? "終了中" : describeRemoteSessionStatus(session.status)}
    </Badge>
  );
}

/**
 * リモートセッション（#4743）。アプリ内チャット（#3975）を置き換えた画面で、会話そのものは
 * Claude Codeアプリ側で行う。ここはリポジトリを選んでセッションを立て、そこへ移動するまでを持つ。
 */
export function RemoteSessionView({
  repositories,
  active = true,
  onBack,
  hideHeader = false,
}: {
  /** 一覧に並べるリポジトリ（アーカイブ済み・非表示は呼び出し側で除く） */
  repositories: ConnectedRepository[];
  active?: boolean;
  onBack?: () => void;
  /** モーダル（#4835）では見出しをダイアログ側が持つため出さない */
  hideHeader?: boolean;
}) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const remote = useRemoteSessions({ active });
  const [query, setQuery] = useState("");
  // Issue詳細の「リモートセッションで聞く」（#5047）から開いたときは、そのリポジトリを選んでおく。
  // 読むのは開いた時点だけで、あとは画面での選択に従う
  const searchParams = useSearchParams();
  const [requested] = useState(() => searchParams.get(REMOTE_SESSION_REPOSITORY_PARAM));
  const [selected, setSelected] = useState<string | null>(requested);
  // スマホは一覧と詳細シートが別なので、リポジトリを指定して開いたときは詳細シートまで開く
  // （PCではシートを描かないので、この初期値は効かない）
  const [sheetOpen, setSheetOpen] = useState(requested !== null);

  const runnable = useMemo(() => runnableRepositories(remote.state, repositories), [remote.state, repositories]);
  const sorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return repositories
      .filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(runnable.has(b.fullName)) - Number(runnable.has(a.fullName)) ||
          Number(b.favorite) - Number(a.favorite) ||
          a.name.localeCompare(b.name),
      );
  }, [repositories, query, runnable]);

  const sessionsByRepo = useMemo(() => {
    const map = new Map<string, RemoteSession[]>();
    for (const session of remote.state?.sessions ?? []) {
      const list = map.get(session.repositoryFullName) ?? [];
      list.push(session);
      map.set(session.repositoryFullName, list);
    }
    return map;
  }, [remote.state]);

  const current = selected ?? sorted.find((repo) => runnable.has(repo.fullName))?.fullName ?? null;
  const currentRepo = repositories.find((repo) => repo.fullName === current) ?? null;

  const choose = (fullName: string) => {
    setSelected(fullName);
    if (!isDesktop) setSheetOpen(true);
  };

  const list = (
    <ul className="flex flex-col gap-0.5" aria-label="リポジトリ">
      {sorted.map((repo) => {
        const sessions = (sessionsByRepo.get(repo.fullName) ?? []).filter(isActive);
        const enabled = runnable.has(repo.fullName);
        return (
          <li key={repo.fullName}>
            <button
              type="button"
              onClick={() => choose(repo.fullName)}
              disabled={!enabled}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent",
                isDesktop && repo.fullName === current && "bg-muted font-medium",
              )}
            >
              {repo.favorite ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : <span className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">
                {repo.name} <span className="text-xs text-muted-foreground">{repo.fullName.split("/")[0]}</span>
              </span>
              {!enabled ? (
                <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">サブPC未登録</Badge>
              ) : sessions.length > 0 ? (
                <Badge variant="outline" className="shrink-0 border-transparent bg-emerald-500/15 text-[11px] text-emerald-700 dark:text-emerald-300">
                  {sessions.length}件稼働
                </Badge>
              ) : null}
            </button>
          </li>
        );
      })}
      {sorted.length === 0 && <li className="px-2.5 py-2 text-sm text-muted-foreground">該当するリポジトリがありません。</li>}
    </ul>
  );

  const detail = currentRepo ? (
    <RepositoryDetail
      repository={currentRepo}
      state={remote.state}
      sessions={sessionsByRepo.get(currentRepo.fullName) ?? []}
      launch={remote.launch?.repositoryFullName === currentRepo.fullName ? remote.launch : null}
      pending={remote.pending}
      error={remote.error}
      onStart={() => void remote.start(currentRepo.fullName)}
      onResume={(session) => void remote.resume(session)}
      onStop={(id) => void remote.stop(id)}
      onDismissLaunch={remote.dismissLaunch}
      compact={!isDesktop}
    />
  ) : (
    <p className="text-sm text-muted-foreground">起動できるリポジトリがありません。サブPCのpollerが動いているか確認してください。</p>
  );

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <header className={cn(hideHeader && "pr-8")}>
        {onBack && (
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={onBack}>
            ← 戻る
          </Button>
        )}
        <h1 className="flex items-center gap-2 text-lg font-semibold" aria-hidden={hideHeader || undefined}>
          <TerminalSquare className="size-5" />
          リモートセッション
        </h1>
        <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card md:flex-row">
        <div className="flex min-h-0 flex-col md:w-80 md:shrink-0 md:border-r">
          <div className="relative p-3">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="remote-session-repo-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="リポジトリを検索"
              className="pl-8"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{list}</div>
        </div>
        {isDesktop && <div className="min-w-0 flex-1 overflow-y-auto p-5">{detail}</div>}
      </div>

      {!isDesktop && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[85svh] gap-3 overflow-y-auto p-4 pb-8">
            <SheetHeader className="p-0 pr-8">
              <SheetTitle>{currentRepo?.name ?? "リモートセッション"}</SheetTitle>
              <SheetDescription>{currentRepo?.fullName}</SheetDescription>
            </SheetHeader>
            {detail}
          </SheetContent>
        </Sheet>
      )}
    </section>
  );
}

function RepositoryDetail({
  repository,
  state,
  sessions,
  launch,
  pending,
  error,
  onStart,
  onResume,
  onStop,
  onDismissLaunch,
  compact,
}: {
  repository: ConnectedRepository;
  state: RemoteSessionState | null;
  sessions: RemoteSession[];
  launch: RemoteSessionLaunch | null;
  pending: boolean;
  error: string | null;
  onStart: () => void;
  onResume: (session: RemoteSession) => void;
  onStop: (id: string) => void;
  onDismissLaunch: () => void;
  compact: boolean;
}) {
  const host = state?.hosts.find((item) => item.remoteSessionCapable && item.repositories.includes(repository.fullName)) ?? null;
  const launching = launch !== null && !launch.gaveUp;
  const launchedSession = launch ? sessions.find((session) => session.id === launch.sessionId) ?? null : null;
  const limitReached = host !== null && state !== null && host.activeCount >= state.maxPerHost;
  const startDisabled = pending || launching || !host || !host.online || limitReached;
  const visible = sessions.filter((session) => isActive(session) || session.id === launch?.sessionId);
  // 会話ごと再開できる終了済みのセッション（#4874）。最後に動いていた順
  const history = sessions
    .filter((session) => isRemoteSessionResumable(session) && !visible.includes(session))
    .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
    .slice(0, HISTORY_LIMIT);
  /** 再開できない理由（できるならnull）。転記はそのセッションが動いていたホストにしか無いので、そのホストで判定する */
  const resumeBlocker = (session: RemoteSession): string | null => {
    const origin = state?.hosts.find((item) => item.name === session.host) ?? null;
    if (!origin || !origin.online) return "サブPCがオフラインです。";
    if (!origin.resumeCapable) return "サブPCのpollerが再開に対応していません。設定の実行環境から「更新して再起動」を押してください。";
    if (state && origin.activeCount >= state.maxPerHost) return "同時に動かせる本数に達しています。";
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      {!compact && (
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold">{repository.name}</h2>
          <span className="font-mono text-xs text-muted-foreground">{repository.fullName}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onStart} disabled={startDisabled} className={cn(compact && "w-full py-5")}>
            {launching || pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {launching || pending ? "起動中…" : "セッションを起動"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {host ? `ホスト ${formatDispatchHostName(host.name)}・モデルは設定の既定` : "起動できるホストがありません"}
          </span>
        </div>
        {host && !host.online && <p className="text-xs text-destructive">サブPCがオフラインです。</p>}
        {limitReached && (
          <p className="text-xs text-destructive">
            同時に動かせるリモートセッションは{state?.maxPerHost}本までです。使っていないセッションを終了してください。
          </p>
        )}
        {launch && <LaunchProgress launch={launch} session={launchedSession} onDismiss={onDismissLaunch} />}
        {!launch && (
          <p className="text-xs text-muted-foreground">
            既定ブランチの最新で作業用ディレクトリを作り、URLが取れたらClaude Codeアプリへ移動します。
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="rounded-lg border bg-background">
        <h3 className="border-b px-4 py-2.5 text-sm font-medium">このリポジトリのリモートセッション</h3>
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">動いているセッションはありません。</p>
        ) : (
          <ul>
            {visible.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{session.tmuxSessionName}</span>
                <StatusBadge session={session} />
                <span className="text-xs text-muted-foreground">
                  {formatDispatchHostName(session.host)}・{formatRelativeDate(session.createdAt)}に起動
                </span>
                <div className="flex w-full justify-end gap-2 sm:w-auto">
                  {session.remoteControlUrl ? (
                    <Button size="sm" asChild>
                      <a href={session.remoteControlUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-3.5" />
                        Claude Codeアプリで開く
                      </a>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      開く
                    </Button>
                  )}
                  {isActive(session) && (
                    <Button size="sm" variant="outline" disabled={session.stopping} onClick={() => onStop(session.id)}>
                      終了
                    </Button>
                  )}
                </div>
                {session.status === "failed" && session.failureMessage && (
                  <p className="w-full text-xs whitespace-pre-wrap text-destructive">{session.failureMessage}</p>
                )}
                {/* 無操作による自動終了（#4871）の理由。失敗ではないので赤くしない */}
                {session.status === "ended" && session.failureMessage && (
                  <p className="w-full text-xs whitespace-pre-wrap text-muted-foreground">{session.failureMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {history.length > 0 && (
        <div className="rounded-lg border bg-background">
          <h3 className="border-b px-4 py-2.5 text-sm font-medium">終了したセッション</h3>
          <ul>
            {history.map((session) => {
              const blocker = resumeBlocker(session);
              return (
                <li key={session.id} className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{session.tmuxSessionName}</span>
                  <StatusBadge session={session} />
                  <span className="text-xs text-muted-foreground">
                    {formatDispatchHostName(session.host)}・
                    {session.lastSeenAt ? `${formatRelativeDate(session.lastSeenAt)}まで稼働` : `${formatRelativeDate(session.createdAt)}に起動`}
                  </span>
                  <div className="flex w-full justify-end gap-2 sm:w-auto">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || launching || blocker !== null}
                      onClick={() => onResume(session)}
                    >
                      <RotateCcw className="size-3.5" />
                      再開
                    </Button>
                  </div>
                  {session.failureMessage && (
                    <p
                      className={cn(
                        "w-full text-xs whitespace-pre-wrap",
                        session.status === "failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {session.failureMessage}
                    </p>
                  )}
                  {blocker && <p className="w-full text-xs text-muted-foreground">{blocker}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        セッションはIssueに紐づかず、終了するか一定時間（既定3時間）操作が無くなるまでサブPCに残ります。終了すると、作業が残っていない作業用ディレクトリは片付けます。終了したセッションは7日間「再開」から会話の続きとして起動し直せます。
      </p>
    </div>
  );
}

function LaunchProgress({
  launch,
  session,
  onDismiss,
}: {
  launch: RemoteSessionLaunch;
  session: RemoteSession | null;
  onDismiss: () => void;
}) {
  if (session?.status === "failed") {
    return (
      <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        <p className="font-medium">起動できませんでした。</p>
        {session.failureMessage && <p className="mt-1 text-xs whitespace-pre-wrap">{session.failureMessage}</p>}
        <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={onDismiss}>
          閉じる
        </Button>
      </div>
    );
  }
  if (launch.gaveUp) {
    return (
      <div className="rounded-md bg-amber-500/10 p-3 text-sm">
        <p>Claude CodeアプリのURLがまだ取れていません。取れると下の一覧の「開く」が押せるようになります。</p>
        <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={onDismiss}>
          閉じる
        </Button>
      </div>
    );
  }
  const running = session?.status === "running";
  const steps = [
    { label: "サブPCへ依頼を積みました", done: true },
    { label: "セッションを立ち上げています", done: running },
    { label: "Claude Codeアプリで開きます", done: false },
  ];
  const nowIndex = steps.findIndex((step) => !step.done);
  return (
    <div className="flex flex-col gap-2 rounded-md bg-primary/5 p-3">
      <ol className="flex flex-col gap-1.5 text-sm">
        {steps.map((step, index) => (
          <li key={step.label} className={cn("flex items-center gap-2", index === nowIndex && "font-medium")}>
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full border-2",
                step.done ? "border-emerald-600 bg-emerald-600" : index === nowIndex ? "border-primary" : "border-muted-foreground/40",
              )}
            />
            {step.label}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">URLが取れた時点で自動で移動します。閉じても起動は続き、下の一覧から開けます。</p>
    </div>
  );
}
