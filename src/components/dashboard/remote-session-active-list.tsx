"use client";

import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  describeRemoteSessionStatus,
  type RemoteSessionView,
} from "@/lib/dispatch/remote-session-rules";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/** ヘッダーのポップオーバー・スマホのダイアログに出す、起動中のセッション（終了中は除く） */
export function selectActiveRemoteSessions(sessions: readonly RemoteSessionView[]): RemoteSessionView[] {
  return sessions
    .filter((session) => !session.stopping && ACTIVE_REMOTE_SESSION_STATUSES.includes(session.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 起動中のリモートセッションの一覧（#4991）。URLが取れたものは1クリックでClaude Codeアプリへ移る。
 * 起動・再開・終了は`RemoteSessionView`が持つため、ここは見る・開くだけ。
 */
export function RemoteSessionActiveList({
  sessions,
  className,
}: {
  sessions: readonly RemoteSessionView[];
  className?: string;
}) {
  const active = selectActiveRemoteSessions(sessions);
  return (
    <section className={cn("flex flex-col gap-1.5", className)} aria-label="起動中のリモートセッション">
      <h3 className="px-1 text-xs font-semibold text-muted-foreground">起動中のセッション（{active.length}）</h3>
      {active.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">起動中のセッションはありません。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {active.map((session) => (
            <li
              key={session.id}
              className="flex items-center gap-2 rounded-lg border bg-emerald-500/5 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{session.repositoryFullName.split("/")[1]}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0 border-transparent text-[11px]",
                      session.status === "running"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                    )}
                  >
                    {describeRemoteSessionStatus(session.status)}
                  </Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {formatDispatchHostName(session.host)}・{formatRelativeDate(session.createdAt)}に起動
                </p>
              </div>
              {session.remoteControlUrl ? (
                <a
                  href={session.remoteControlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                >
                  開く
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="shrink-0 rounded-md border px-3 py-1.5 text-xs text-muted-foreground">準備中</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
