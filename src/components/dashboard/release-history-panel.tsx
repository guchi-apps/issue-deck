"use client";

import { Check, ChevronDown, CircleAlert, ExternalLink, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  buildReleaseCheckIndex,
  countUncheckedReleases,
  resolveReleaseCheckStatus,
  selectUncheckedReleases,
  type ReleaseCheckRecord,
  type ReleaseCheckStatus,
  type ReleaseCheckTargetSummary,
} from "@/lib/release-check";
import { extractReleaseHighlights, groupReleaseHistoryByJstDate } from "@/lib/release-history";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";

/** 対象リポジトリの選択欄に出す1件 */
export type ReleaseCheckRepositoryOption = {
  id: string;
  name: string;
  fullName: string;
};

/**
 * 「リリース履歴」画面（#2726）。全リポジトリのGitHub Releaseを公開日時の新しい順に
 * 1本のタイムラインへ束ね、日付ごとにグルーピングして表示する。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`preview-panel.tsx`・
 * `session-usage-panel.tsx`と同じ切り分け）。
 *
 * `entries`は呼び出し側（`issue-deck-shell.tsx`）で非表示リポジトリぶんを除いた後のものを渡す
 * （`selectVisibleReleaseHistory`。#2279の「Issueとリリース状況はクライアント側で除く」と同じ方針）。
 *
 * #2930で、リリースごとに「本番での動作確認が済んだか」のフラグを持つようになった。
 * **状態そのものは受け取らず、材料（対象リポジトリと確認済みの記録）から
 * `lib/release-check.ts`の純粋関数で畳む**——切り替えた直後の楽観的更新が同じ判定を通る。
 */
export function ReleaseHistoryPanel({
  entries,
  isLoading,
  error,
  onRefresh,
  checkTargets,
  checkRecords,
  checkRepositoryOptions,
  onToggleChecked,
  onToggleCheckTarget,
  compact = false,
  className,
}: {
  entries: ReleaseHistoryItem[] | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** 動作確認の対象に選んだリポジトリ（#2930） */
  checkTargets: ReleaseCheckTargetSummary[];
  /** 確認済みの記録（#2930） */
  checkRecords: ReleaseCheckRecord[];
  /** 対象リポジトリの選択欄に出す候補 */
  checkRepositoryOptions: ReleaseCheckRepositoryOption[];
  onToggleChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => void;
  onToggleCheckTarget: (
    repository: { id: string; fullName: string },
    targeted: boolean,
  ) => void;
  /** スマホ向けに縮める。見出しの説明文を落とす */
  compact?: boolean;
  className?: string;
}) {
  const [uncheckedOnly, setUncheckedOnly] = useState(false);

  const checkIndex = useMemo(
    () => buildReleaseCheckIndex(checkTargets, checkRecords),
    [checkTargets, checkRecords],
  );

  const uncheckedCount = useMemo(
    () => countUncheckedReleases(entries ?? [], checkIndex),
    [entries, checkIndex],
  );

  // 絞り込みは表示の直前に掛ける。件数（`uncheckedCount`）は絞り込みの前の母集団から数えるので、
  // 「未確認だけ」に切り替えても数字が動かない。
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    return uncheckedOnly ? selectUncheckedReleases(entries, checkIndex) : entries;
  }, [entries, uncheckedOnly, checkIndex]);

  const groups = useMemo(
    () => groupReleaseHistoryByJstDate(visibleEntries ?? []),
    [visibleEntries],
  );

  const targetedFullNames = useMemo(
    () => new Set(checkTargets.map((target) => target.repoFullName)),
    [checkTargets],
  );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">リリース履歴</h2>
          {!compact && (
            <p className="text-[11px] text-muted-foreground">
              全リポジトリのGitHub Releaseを新しい順に並べたタイムラインです
            </p>
          )}
        </div>

        {uncheckedCount > 0 && (
          <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-50 px-2 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <CircleAlert className="size-3" aria-hidden />
            未確認 {uncheckedCount}件
          </span>
        )}

        <Button
          variant={uncheckedOnly ? "secondary" : "outline"}
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          aria-pressed={uncheckedOnly}
          onClick={() => setUncheckedOnly((prev) => !prev)}
        >
          未確認だけ
        </Button>

        <CheckTargetPicker
          options={checkRepositoryOptions}
          targetedFullNames={targetedFullNames}
          onToggle={onToggleCheckTarget}
        />

        <Button
          variant="outline"
          size="icon"
          className="size-7 shrink-0"
          onClick={onRefresh}
          title="更新"
        >
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

      {/* 絞り込んだ結果が空になるのと、そもそもリリースが無いのとは別の案内にする */}
      {entries && entries.length > 0 && uncheckedOnly && groups.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          未確認のリリースはありません。
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
                  <ReleaseHistoryCard
                    key={`${entry.repoFullName}-${entry.tagName}`}
                    entry={entry}
                    status={resolveReleaseCheckStatus(entry, checkIndex)}
                    /*
                      「対象外」の印は、**対象を1つでも選んでいて、かつそのリポジトリ自体を
                      選んでいないとき**にだけ出す。既定はどれも対象外なので、無条件に出すと
                      最初は全カードがこの印で埋まる。逆に対象を選んだ後は、印が無いカードと
                      あるカードの違いが「選んでいないリポジトリだから」だと読み取れる。
                      対象リポジトリの古いリリース（加えた時点より前）には出さない——
                      1リポジトリにつき最大20件あり、印だけが並ぶことになるため。
                    */
                    outOfScopeReason={
                      targetedFullNames.size > 0 && !targetedFullNames.has(entry.repoFullName)
                        ? "not_targeted"
                        : null
                    }
                    onToggleChecked={onToggleChecked}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 動作確認の対象リポジトリを選ぶ（#2930）。
 *
 * **既定はどれも対象外。** この画面は全リポジトリ×最大20件のリリースを並べるため、
 * 無条件に未確認を立てると初回に数百件立つ（`lib/release-check.ts`のコメントを参照）。
 */
function CheckTargetPicker({
  options,
  targetedFullNames,
  onToggle,
}: {
  options: ReleaseCheckRepositoryOption[];
  targetedFullNames: Set<string>;
  onToggle: (repository: { id: string; fullName: string }, targeted: boolean) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="size-7 shrink-0"
          title="確認の対象リポジトリ"
        >
          <Settings2 className="size-3.5" />
          <span className="sr-only">確認の対象リポジトリ</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <h3 className="px-1 text-xs font-bold">確認の対象リポジトリ</h3>
        <p className="mt-1 px-1 text-[10.5px] leading-relaxed text-muted-foreground">
          選んだリポジトリは、<b className="font-semibold">これから公開されるリリース</b>
          に「未確認」が付きます。過去のリリースには付きません。
        </p>

        {options.length === 0 ? (
          <p className="mt-2 px-1 py-2 text-[11px] text-muted-foreground">
            選べるリポジトリがありません。
          </p>
        ) : (
          <ul className="mt-2 flex max-h-72 flex-col gap-px overflow-y-auto">
            {options.map((option) => {
              const targeted = targetedFullNames.has(option.fullName);
              return (
                <li key={option.id}>
                  {/*
                    `repository-visibility-section.tsx`と同じ形。`Checkbox`（Radix）の実体は
                    `button`で`label`のhtmlForが届かないため、行のクリックで切り替え、
                    チェックボックス自身のクリックはそこで止めて二重に切り替わらないようにする。
                  */}
                  <div
                    onClick={() => onToggle(option, !targeted)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent"
                  >
                    <Checkbox
                      checked={targeted}
                      aria-label={`${option.name}のリリースを確認の対象にする`}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={(checked) => onToggle(option, checked === true)}
                    />
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: getRepoColor(option.fullName) }}
                    />
                    <span className="truncate text-xs">{option.name}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 折りたたみ時に表示する行数。`extractReleaseHighlights`の既定`max`と揃える */
const PREVIEW_LINE_COUNT = 3;

function ReleaseHistoryCard({
  entry,
  status,
  outOfScopeReason,
  onToggleChecked,
}: {
  entry: ReleaseHistoryItem;
  status: ReleaseCheckStatus;
  /** `not_targeted`のときだけ「対象外」の印を出す（nullなら何も出さない） */
  outOfScopeReason: "not_targeted" | null;
  onToggleChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => void;
}) {
  const repoName = entry.repoFullName.split("/")[1] ?? entry.repoFullName;
  const [expanded, setExpanded] = useState(false);
  const { lines: allLines } = extractReleaseHighlights(entry.body, Number.POSITIVE_INFINITY);
  const lines = expanded ? allLines : allLines.slice(0, PREVIEW_LINE_COUNT);
  const hiddenCount = allLines.length - lines.length;
  const target = { repoFullName: entry.repoFullName, tagName: entry.tagName };

  return (
    <li
      className={cn(
        "relative -ml-[18.5px] list-none rounded-md border bg-card p-2.5 pl-3",
        status.kind === "unchecked" && "border-amber-500/50",
      )}
    >
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
        {status.kind === "unchecked" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-50 px-1.5 py-px text-[10.5px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <CircleAlert className="size-2.5" aria-hidden />
            未確認
          </span>
        )}
        {status.kind === "checked" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-50 px-1.5 py-px text-[10.5px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <Check className="size-2.5" aria-hidden />
            確認済み
          </span>
        )}
        {status.kind === "out_of_scope" && outOfScopeReason === "not_targeted" && (
          <span
            className="inline-flex items-center rounded-full border border-dashed px-1.5 py-px text-[10.5px] text-muted-foreground"
            title="このリポジトリは確認の対象に選ばれていません"
          >
            対象外
          </span>
        )}
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

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={entry.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
          GitHubで見る
        </a>

        {status.kind === "unchecked" && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 shrink-0 gap-1 border-amber-500/50 px-2 text-[11px] font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
            onClick={() => onToggleChecked(target, true)}
          >
            <Check className="size-3" aria-hidden />
            確認済みにする
          </Button>
        )}

        {status.kind === "checked" && (
          <>
            <span
              className="ml-auto shrink-0 text-[11px] text-muted-foreground"
              title={formatDateTime(status.checkedAt)}
            >
              {formatDateTime(status.checkedAt)} に確認
            </span>
            <button
              type="button"
              onClick={() => onToggleChecked(target, false)}
              className="shrink-0 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              未確認に戻す
            </button>
          </>
        )}
      </div>
    </li>
  );
}
