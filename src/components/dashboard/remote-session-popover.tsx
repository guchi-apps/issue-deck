"use client";

import { Loader2, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { RemoteSessionActiveList } from "@/components/dashboard/remote-session-active-list";
import { runnableRepositories } from "@/components/dashboard/remote-session-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useRemoteSessions } from "@/hooks/use-remote-sessions";
import { summarizeRemoteSessionNav } from "@/lib/dispatch/remote-session-rules";
import type { ConnectedRepository } from "@/types/repository";

/**
 * PCのトップバーに置くリモートセッションのアイコン（#4991）。押すと上段に起動中のセッション
 * （1クリックでClaude Codeアプリへ）、下段に新しく起動するリポジトリの一覧を出す。
 * 一覧の全画面表示（再開・終了）は左メニューの「リモートセッション」が持つ。
 */
export function RemoteSessionPopover({ repositories }: { repositories: ConnectedRepository[] }) {
  const dispatch = useDispatchState(true);
  const [open, setOpen] = useState(false);
  const nav = summarizeRemoteSessionNav(dispatch.remoteSessions, dispatch.isLoaded);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex items-center gap-1 rounded-md p-1.5 hover:bg-accent"
          aria-label="リモートセッション"
          title="リモートセッション"
        >
          <TerminalSquare className="size-4" />
          {nav.count !== null && nav.count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[10px] leading-4 text-white">
              {nav.count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[75vh] w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto">
        <PopoverBody
          sessions={dispatch.remoteSessions}
          repositories={repositories}
          open={open}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** 開いている間しか描かれない。ルーターを要求するフックと取得はここで行う */
function PopoverBody({
  sessions,
  repositories,
  open,
  onClose,
}: {
  sessions: ReturnType<typeof useDispatchState>["remoteSessions"];
  repositories: ConnectedRepository[];
  open: boolean;
  onClose: () => void;
}) {
  const { openRemoteSessions } = useReferenceNavigation();
  const remote = useRemoteSessions({
    active: open,
    onReady: (url) => {
      window.location.assign(url);
    },
  });
  const [query, setQuery] = useState("");
  const runnable = useMemo(() => runnableRepositories(remote.state, repositories), [remote.state, repositories]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return repositories
      .filter((repo) => runnable.has(repo.fullName) && (!needle || repo.fullName.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  }, [repositories, runnable, query]);
  const launching = remote.pending || (remote.launch !== null && !remote.launch.gaveUp);

  return (
    <div className="flex flex-col gap-3">
      <RemoteSessionActiveList sessions={remote.state?.sessions ?? sessions} />
      <section className="flex flex-col gap-1.5" aria-label="新しく起動する">
        <h3 className="px-1 text-xs font-semibold text-muted-foreground">新しく起動する</h3>
        <Input
          id="remote-session-popover-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="リポジトリを検索"
        />
        <ul className="flex max-h-56 flex-col overflow-y-auto">
          {candidates.map((repo) => (
            <li key={repo.fullName} className="flex items-center gap-2 border-t px-1 py-1.5 text-sm first:border-t-0">
              <span className="min-w-0 flex-1 truncate">{repo.name}</span>
              <Button size="sm" variant="ghost" disabled={launching} onClick={() => void remote.start(repo.fullName)}>
                起動
              </Button>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="px-1 py-2 text-sm text-muted-foreground">起動できるリポジトリがありません。</li>
          )}
        </ul>
        {launching && (
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            起動しています。準備ができたらClaude Codeアプリへ移動します。
          </p>
        )}
        {remote.error && <p className="px-1 text-xs text-destructive">{remote.error}</p>}
      </section>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          onClose();
          openRemoteSessions();
        }}
      >
        再開・終了などの一覧を開く
      </Button>
    </div>
  );
}
