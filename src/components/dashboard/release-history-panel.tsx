"use client";

import { ChevronDown, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import { extractReleaseHighlights, groupReleaseHistoryByJstDate } from "@/lib/release-history";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";

/**
 * 「リリース履歴」画面（#2726）。全リポジトリのGitHub Releaseを公開日時の新しい順に
 * 1本のタイムラインへ束ね、日付ごとにグルーピングして表示する。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`preview-panel.tsx`・
 * `session-usage-panel.tsx`と同じ切り分け）。
 *
 * `entries`は呼び出し側（`issue-deck-shell.tsx`）で非表示リポジトリぶんを除いた後のものを渡す
 * （`selectVisibleReleaseHistory`。#2279の「Issueとリリース状況はクライアント側で除く」と同じ方針）。
 */
export function ReleaseHistoryPanel({
  entries,
  isLoading,
  error,
  onRefresh,
  compact = false,
  className,
}: {
  entries: ReleaseHistoryItem[] | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** スマホ向けに縮める。見出しの説明文を落とす */
  compact?: boolean;
  className?: string;
}) {
  const groups = useMemo(() => groupReleaseHistoryByJstDate(entries ?? []), [entries]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">リリース履歴</h2>
          {!compact && (
            <p className="text-[11px] text-muted-foreground">
              全リポジトリのGitHub Releaseを新しい順に並べたタイムラインです
            </p>
          )}
        </div>
        <Button variant="outline" size="icon" className="size-7" onClick={onRefresh} title="更新">
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          <span className="sr-only">更新</span>
        </Button>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isLoading && !entries && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {entries && entries.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          リリースがまだありません。
        </p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.dateKey}>
              <h3 className="mb-2 flex items-baseline gap-2 pl-0.5 text-xs font-bold">
                {group.month}月{group.day}日
                <span className="text-[11px] font-normal text-muted-foreground">
                  {group.weekdayLabel}
                </span>
              </h3>
              <ol className="relative flex flex-col gap-3 border-l pl-4">
                {group.entries.map((entry) => (
                  <ReleaseHistoryCard key={`${entry.repoFullName}-${entry.tagName}`} entry={entry} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** 折りたたみ時に表示する行数。`extractReleaseHighlights`の既定`max`と揃える */
const PREVIEW_LINE_COUNT = 3;

function ReleaseHistoryCard({ entry }: { entry: ReleaseHistoryItem }) {
  const repoName = entry.repoFullName.split("/")[1] ?? entry.repoFullName;
  const [expanded, setExpanded] = useState(false);
  const { lines: allLines } = extractReleaseHighlights(entry.body, Number.POSITIVE_INFINITY);
  const lines = expanded ? allLines : allLines.slice(0, PREVIEW_LINE_COUNT);
  const hiddenCount = allLines.length - lines.length;

  return (
    <li className="relative -ml-[18.5px] list-none rounded-md border bg-card p-2.5 pl-3">
      <span
        aria-hidden
        className="absolute top-3.5 -left-[7px] size-2.5 rounded-full ring-2 ring-background"
        style={{ backgroundColor: getRepoColor(entry.repoFullName) }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: getRepoColor(entry.repoFullName) }}
        />
        <span className="text-xs font-semibold">{repoName}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{entry.tagName}</span>
        {entry.publishedAt && (
          <span
            className="ml-auto shrink-0 text-[11px] text-muted-foreground"
            title={formatDateTime(entry.publishedAt)}
          >
            {formatRelativeDate(entry.publishedAt)}
          </span>
        )}
      </div>

      {lines.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {lines.map((line, index) => (
            <li key={index} className="pl-3 text-xs leading-relaxed text-foreground/90 relative">
              <span aria-hidden className="absolute left-0 top-[7px] size-1 rounded-full bg-muted-foreground" />
              {line}
            </li>
          ))}
        </ul>
      )}

      {(hiddenCount > 0 || (expanded && allLines.length > PREVIEW_LINE_COUNT)) && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-1 inline-flex items-center gap-0.5 pl-3 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          {expanded ? "折りたたむ" : `ほか${hiddenCount}件を見る`}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
        </button>
      )}

      <a
        href={entry.htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="size-3" aria-hidden />
        GitHubで見る
      </a>
    </li>
  );
}
