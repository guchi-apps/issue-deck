"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { CodeReviewRepoRow } from "@/lib/code-review-repo-overview";
import { formatMonthDay } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/** 「すべて表示」の開閉を端末に覚えておくキー */
const EXPANDED_STORAGE_KEY = "code-review-repo-overview-expanded";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // 覚えておけないだけで、開閉そのものは効く
  }
}

/**
 * 「コードレビュー」ビューの先頭に置く、リポジトリ別のレビュー状況（#3092）。
 *
 * 1行が1リポジトリで、**いつレビューしたか**（直近12週の帯に点・前回の日付と経過日数・回数）と
 * **前回以降に入ったPRの件数**を出す。PRの件数はグラフにせず数字だけにする。
 *
 * 行を押すとそのリポジトリのレビューだけに一覧が絞られ（選択はこの画面の中だけで持つ。
 * このビューは上部の絞り込みが効かない作り〈#1750〉のため）、「実行」でそのリポジトリを
 * 選んだ状態のレビュー実行ダイアログが開く。
 *
 * **たたんでいる間は行の一覧も凡例も出さず**、見出しと「すべて表示」だけにする（#3125）。
 * 実行の入口は各行の「実行」だけで、見出しに別の「レビューを実行」は置かない。
 * 絞り込み中の行だけは、解除できるようたたんでも残す。
 *
 * 幅が狭い（スマホ・一覧の列を細くしたPC）ときは帯を2行目へ回す。判定は画面幅ではなく
 * 一覧の列の幅で行う（`@container`）。
 */
export function CodeReviewRepoOverview({
  rows,
  sinceLastCounts,
  countsLoading,
  selectedRepositoryFullName,
  onSelectRepository,
  onStartCodeReview,
}: {
  rows: CodeReviewRepoRow[];
  /** リポジトリ名 → 前回以降に入ったPRの件数。取れていないものは入らない */
  sinceLastCounts: ReadonlyMap<string, number>;
  countsLoading: boolean;
  selectedRepositoryFullName: string | null;
  onSelectRepository: (repositoryFullName: string | null) => void;
  /** 渡されていなければ各行の実行ボタンを出さない */
  onStartCodeReview?: (repositoryFullName: string) => void;
}) {
  // 端末の記憶はマウント後に読む（サーバーの描画と食い違わせない）
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(readExpanded());
  }, []);
  const toggleExpanded = () => {
    setExpanded((value) => {
      writeExpanded(!value);
      return !value;
    });
  };

  // 選んでいる行は、たたんでいても隠さない（隠すと絞り込みを解除できない）
  const visibleRows = expanded
    ? rows
    : rows.filter((row) => row.repositoryFullName === selectedRepositoryFullName);

  return (
    <section
      aria-label="リポジトリ別のレビュー"
      className="@container shrink-0 border-b bg-emerald-500/5"
    >
      <div className="flex items-center gap-2 px-4 pt-2 pb-1">
        <h2 className="text-xs font-semibold">リポジトリ別のレビュー</h2>
        <span className="text-[11px] text-muted-foreground">前回からの経過が長い順</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          レビューを実行できるリポジトリがまだありません。サブPCにチェックアウトがあるリポジトリが
          ここに並びます。
        </p>
      ) : (
        <>
          {expanded && (
            <div className="flex flex-wrap items-center gap-x-3 px-4 pb-1 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-emerald-500" />
                レビュー
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full border-2 border-emerald-500" />
                結果待ち
              </span>
              <span className="hidden @md:inline">帯は直近12週（左端が12週前、右端が今日）</span>
            </div>
          )}
          {/* 行の領域だけに高さの上限を置き、はみ出した分はこの中でスクロールさせる。
              上限が無いと「すべて表示」で枠が画面を占めきり、下のレビュー結果の一覧が
              押し出されて見えなくなる（#3113）。見出し・「たたむ」は枠の外なので常に届く */}
          {visibleRows.length > 0 && (
            <ul className="flex max-h-[45dvh] flex-col overflow-y-auto overscroll-contain pb-1">
              {visibleRows.map((row) => (
                <CodeReviewRepoOverviewRow
                  key={row.repositoryFullName}
                  row={row}
                  sinceLastCount={sinceLastCounts.get(row.repositoryFullName)}
                  countsLoading={countsLoading}
                  selected={row.repositoryFullName === selectedRepositoryFullName}
                  onSelect={() =>
                    onSelectRepository(
                      row.repositoryFullName === selectedRepositoryFullName
                        ? null
                        : row.repositoryFullName,
                    )
                  }
                  onStartCodeReview={
                    onStartCodeReview && row.canRun
                      ? () => onStartCodeReview(row.repositoryFullName)
                      : undefined
                  }
                />
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={toggleExpanded}
            className="px-4 pb-2 text-xs text-emerald-700 hover:underline dark:text-emerald-400"
          >
            {expanded ? "たたむ" : `すべて表示（${rows.length}件）`}
          </button>
        </>
      )}
    </section>
  );
}

function CodeReviewRepoOverviewRow({
  row,
  sinceLastCount,
  countsLoading,
  selected,
  onSelect,
  onStartCodeReview,
}: {
  row: CodeReviewRepoRow;
  sinceLastCount: number | undefined;
  countsLoading: boolean;
  selected: boolean;
  onSelect: () => void;
  onStartCodeReview?: () => void;
}) {
  const name = row.repositoryFullName.split("/")[1] ?? row.repositoryFullName;
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_6.5rem_3rem] items-center gap-x-2 gap-y-1 px-4 py-1",
        "@md:grid-cols-[minmax(0,1fr)_9rem_6.5rem_3rem]",
        selected ? "bg-emerald-500/15" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={
          selected
            ? "選択を解除して全件に戻す"
            : `${row.repositoryFullName}のレビューだけを一覧に出す`
        }
        className="truncate text-left text-xs font-medium hover:underline"
      >
        {name}
      </button>
      <ReviewTimelineStrip
        row={row}
        className="order-last col-span-3 @md:order-none @md:col-span-1"
      />
      <div
        className={cn(
          "text-xs tabular-nums whitespace-nowrap",
          row.stale && "text-amber-700 dark:text-amber-400",
        )}
      >
        {row.lastReviewedAt === null ? (
          <>
            未実施
            <span className="block text-[10px] text-muted-foreground">—</span>
          </>
        ) : (
          <>
            {formatMonthDay(row.lastReviewedAt)}
            <span className="block text-[10px] text-muted-foreground">
              {row.daysSinceLast === 0 ? "今日" : `${row.daysSinceLast}日前`}・{row.reviews.length}回
            </span>
            <span className="block text-[10px] text-muted-foreground">
              以降のPR{" "}
              <span className="text-foreground">
                {sinceLastCount !== undefined
                  ? `${sinceLastCount}件`
                  : countsLoading
                    ? "…"
                    : "—"}
              </span>
            </span>
          </>
        )}
      </div>
      <div className="flex justify-end">
        {onStartCodeReview && (
          <Button size="xs" variant="outline" onClick={onStartCodeReview}>
            実行
          </Button>
        )}
      </div>
    </li>
  );
}

/** 直近12週の帯。点1つがレビュー1回で、結果待ちは白抜き */
function ReviewTimelineStrip({ row, className }: { row: CodeReviewRepoRow; className?: string }) {
  return (
    <div
      className={cn("relative h-3.5 rounded-sm bg-muted", className)}
      aria-label={`直近12週のレビュー ${row.dots.length}回`}
      role="img"
    >
      {row.dots.map((dot) => (
        <span
          key={dot.issueId}
          className={cn(
            "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background",
            dot.pending ? "border-2 border-emerald-500 bg-background" : "bg-emerald-500",
          )}
          // 端の点が帯からはみ出さないよう、半径ぶん内側へ寄せる
          style={{ left: `calc(4px + ${dot.position} * (100% - 8px))` }}
        />
      ))}
    </div>
  );
}
