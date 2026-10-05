"use client";

import { Check, CircleAlert, ExternalLink, Loader2, RefreshCw, Settings2, Smartphone } from "lucide-react";
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
  buildReleaseCheckLineIndex,
  countUncheckedReleases,
  resolveReleaseCheckLineStatus,
  resolveReleaseCheckStatus,
  selectUncheckedReleases,
  type ReleaseCheckLineIndex,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
  type ReleaseCheckStatus,
  type ReleaseCheckTargetSummary,
} from "@/lib/release-check";
import {
  extractReleaseHighlights,
  groupReleaseHistoryByJstDate,
  resolveReleasePullRequestId,
  type ReleaseHighlightLine,
} from "@/lib/release-history";
import {
  carriedNoteLineKey,
  type CarriedRelease,
  type ReleaseNotesSnapshot,
  type UnreleasedDeployState,
} from "@/lib/release-recovery";
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
  checkLineRecords,
  checkRepositoryOptions,
  onToggleChecked,
  onToggleCheckedLine,
  onToggleCheckTarget,
  onOpenPullRequest,
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
  /** 箇条書き行ごとの確認記録（#2982） */
  checkLineRecords: ReleaseCheckLineRecord[];
  /** 対象リポジトリの選択欄に出す候補 */
  checkRepositoryOptions: ReleaseCheckRepositoryOption[];
  onToggleChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => void;
  /** 箇条書き1行の確認チェックを切り替える（#2982） */
  onToggleCheckedLine: (
    target: { repoFullName: string; tagName: string; lineKey: string },
    checked: boolean,
  ) => void;
  onToggleCheckTarget: (
    repository: { id: string; fullName: string },
    targeted: boolean,
  ) => void;
  /**
   * 箇条書きのPRタイトルを押したときに、そのPR詳細を開く（#3128）。引数はPR id
   * （`<owner>/<repo>#<番号>`）。渡さなければタイトルは押せないテキストのまま。
   */
  onOpenPullRequest?: (pullRequestId: string) => void;
  /** スマホ向けに縮める。見出しの説明文を落とす */
  compact?: boolean;
  className?: string;
}) {
  // 初期表示は未確認のリリースだけ（#3170）。確認済み・対象外も見たいときだけボタンで全件へ切り替える。
  // 画面を開くたびに初期値へ戻す（永続化しない）。
  const [showAll, setShowAll] = useState(false);

  const checkIndex = useMemo(
    () => buildReleaseCheckIndex(checkTargets, checkRecords),
    [checkTargets, checkRecords],
  );

  const checkLineIndex = useMemo(
    () => buildReleaseCheckLineIndex(checkLineRecords),
    [checkLineRecords],
  );

  const uncheckedCount = useMemo(
    () => countUncheckedReleases(entries ?? [], checkIndex),
    [entries, checkIndex],
  );

  // 絞り込みは表示の直前に掛ける。件数（`uncheckedCount`）は絞り込みの前の母集団から数えるので、
  // 「確認済みも表示」に切り替えても数字が動かない。
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    return showAll ? entries : selectUncheckedReleases(entries, checkIndex);
  }, [entries, showAll, checkIndex]);

  const groups = useMemo(
    () => groupReleaseHistoryByJstDate(visibleEntries ?? []),
    [visibleEntries],
  );

  const targetedFullNames = useMemo(
    () => new Set(checkTargets.map((target) => target.repoFullName)),
    [checkTargets],
  );

  // 失敗版のカードは動作確認の対象外で、未確認だけの表示には出ない。相手のカードへ移るときは
  // 全件表示へ切り替えてから、描き直しを待ってスクロールする（#4003）。
  function jumpToRelease(target: { repoFullName: string; tagName: string }) {
    setShowAll(true);
    window.setTimeout(() => {
      document
        .getElementById(releaseCardId(target.repoFullName, target.tagName))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">リリース履歴</h2>
          {!compact && (
            <p className="text-[11px] text-muted-foreground">
              {showAll
                ? "全リポジトリのリリース（デプロイに失敗した版を含む）を新しい順に並べたタイムラインです"
                : "未確認のリリースを新しい順に並べています"}
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
          variant={showAll ? "secondary" : "outline"}
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          aria-pressed={showAll}
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll && <Check className="size-3" aria-hidden />}
          確認済みも表示
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
      {entries && entries.length > 0 && !showAll && groups.length === 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <span>未確認のリリースはありません。</span>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs font-semibold text-foreground underline underline-offset-2"
          >
            確認済みも表示
          </button>
        </div>
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
                    checkLineIndex={checkLineIndex}
                    onToggleCheckedLine={onToggleCheckedLine}
                    onOpenPullRequest={onOpenPullRequest}
                    onJumpToRelease={jumpToRelease}
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

function ReleaseHistoryCard({
  entry,
  status,
  outOfScopeReason,
  onToggleChecked,
  checkLineIndex,
  onToggleCheckedLine,
  onOpenPullRequest,
  onJumpToRelease,
}: {
  entry: ReleaseHistoryItem;
  status: ReleaseCheckStatus;
  /** `not_targeted`のときだけ「対象外」の印を出す（nullなら何も出さない） */
  outOfScopeReason: "not_targeted" | null;
  onToggleChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => void;
  /** 箇条書き行ごとの確認記録の索引（#2982） */
  checkLineIndex: ReleaseCheckLineIndex;
  onToggleCheckedLine: (
    target: { repoFullName: string; tagName: string; lineKey: string },
    checked: boolean,
  ) => void;
  onOpenPullRequest?: (pullRequestId: string) => void;
  /** 失敗版・修正版の相手のカードへ移る（#4003） */
  onJumpToRelease: (target: { repoFullName: string; tagName: string }) => void;
}) {
  const repoName = entry.repoFullName.split("/")[1] ?? entry.repoFullName;
  const { lines } = extractReleaseHighlights(entry.body, Number.POSITIVE_INFINITY);
  const target = { repoFullName: entry.repoFullName, tagName: entry.tagName };

  return (
    <li
      id={releaseCardId(entry.repoFullName, entry.tagName)}
      className={cn(
        "relative -ml-[18.5px] scroll-mt-4 list-none rounded-md border bg-card p-2.5 pl-3",
        status.kind === "unchecked" && "border-amber-500/50",
        entry.deployState === "failed" && "border-red-500/40",
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
        {entry.deployState !== undefined && <DeployStateBadge state={entry.deployState} />}
        {entry.iosDeliveredBuild !== undefined && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-50 px-1.5 py-px text-[10.5px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
            title="このリリースのコミットはTestFlightへ配布済みです"
          >
            <Smartphone className="size-2.5" aria-hidden />
            TestFlight配布済み #{entry.iosDeliveredBuild}
          </span>
        )}
        {entry.iosFailureStage !== undefined && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-red-500/50 bg-red-50 px-1.5 py-px text-[10.5px] font-bold text-red-700 dark:bg-red-950/40 dark:text-red-300"
            title="このリリースのiOS配布は失敗しており、TestFlightへ配布されていません"
          >
            <CircleAlert className="size-2.5" aria-hidden />
            {entry.iosFailureStage ? `iOS配布に失敗（${entry.iosFailureStage}）` : "iOS配布に失敗"}
          </span>
        )}
        {entry.iosNotDistributed === true && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-dashed px-1.5 py-px text-[10.5px] text-muted-foreground"
            title="TestFlightへの配布済みタグが無い版です（iOS更新が不要と判定された版を含みます）"
          >
            <Smartphone className="size-2.5" aria-hidden />
            iOS自動配布なし
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

      {entry.deployState !== undefined ? (
        <>
          <UnreleasedRelation entry={entry} onJumpToRelease={onJumpToRelease} />
          <ReleaseNotesView notes={entry.releaseNotes} />
          {entry.bodyUnavailableReason ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{entry.bodyUnavailableReason}</p>
          ) : (
            lines.length > 0 && (
              <ReleaseLineList
                heading="この版に含まれるPR"
                lines={lines}
                repoFullName={entry.repoFullName}
                onOpenPullRequest={onOpenPullRequest}
              />
            )
          )}
        </>
      ) : (
        <>
          {/* 失敗版を引き継いだ版では、この版で足した修正と引き継いだ変更を見分けられるようにする（#4003） */}
          {(lines.length > 0 || entry.carriedOver) && (
            <ReleaseLineList
              heading={entry.carriedOver ? "復旧のために追加した修正" : undefined}
              lines={lines}
              repoFullName={entry.repoFullName}
              onOpenPullRequest={onOpenPullRequest}
              check={{ target, index: checkLineIndex, onToggle: onToggleCheckedLine }}
            />
          )}
          {entry.carriedOver?.map((carried) => (
            <CarriedReleaseSection
              key={carried.tagName}
              carried={carried}
              repoFullName={entry.repoFullName}
              target={target}
              checkLineIndex={checkLineIndex}
              onToggleCheckedLine={onToggleCheckedLine}
              onOpenPullRequest={onOpenPullRequest}
              onJumpToRelease={onJumpToRelease}
            />
          ))}
        </>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={entry.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
          {entry.deployState !== undefined ? "タグをGitHubで見る" : "GitHubで見る"}
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

/** カードのDOM id。失敗版と修正版の間を行き来するために使う（#4003） */
function releaseCardId(repoFullName: string, tagName: string): string {
  return `release-${repoFullName.replace(/[^A-Za-z0-9_-]/g, "-")}-${tagName.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

const DEPLOY_STATE_LABEL: Record<UnreleasedDeployState, { label: string; title: string; tone: "red" | "muted" }> = {
  failed: {
    label: "デプロイ失敗",
    title: "この版の本番デプロイは失敗し、GitHub Releaseは作られていません",
    tone: "red",
  },
  in_progress: { label: "デプロイ中", title: "この版の本番デプロイを実行中です", tone: "muted" },
  unknown: {
    label: "デプロイ結果不明",
    title: "GitHub Releaseが無く、本番デプロイの結果も確認できません",
    tone: "muted",
  },
  succeeded_without_release: {
    label: "Release未作成",
    title: "本番デプロイは成功しましたが、GitHub Releaseが作られていません",
    tone: "muted",
  },
};

function DeployStateBadge({ state }: { state: UnreleasedDeployState }) {
  const { label, title, tone } = DEPLOY_STATE_LABEL[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] font-bold",
        tone === "red"
          ? "border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
          : "border-dashed text-muted-foreground",
      )}
      title={title}
    >
      {tone === "red" && <CircleAlert className="size-2.5" aria-hidden />}
      {label}
    </span>
  );
}

function JumpButton({ tagName, onClick }: { tagName: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono font-semibold text-foreground underline underline-offset-2"
    >
      {tagName}
    </button>
  );
}

/** Releaseが無い版が、本番へ出たのかどうか・どの版で出たのか（#4003） */
function UnreleasedRelation({
  entry,
  onJumpToRelease,
}: {
  entry: ReleaseHistoryItem;
  onJumpToRelease: (target: { repoFullName: string; tagName: string }) => void;
}) {
  const recoveredBy = entry.recoveredBy;
  let message: React.ReactNode;
  if (entry.deployState === "failed") {
    message = recoveredBy ? (
      <>
        この版の変更は{" "}
        <JumpButton
          tagName={recoveredBy}
          onClick={() => onJumpToRelease({ repoFullName: entry.repoFullName, tagName: recoveredBy })}
        />{" "}
        で本番へ反映されました。
      </>
    ) : (
      "この版の変更は、まだ本番へ反映されていません。"
    );
  } else if (entry.deployState === "in_progress") {
    message = "本番デプロイを実行中です。終わるとGitHub Releaseが作られます。";
  } else if (entry.deployState === "unknown") {
    message = "GitHub Releaseが無く、本番デプロイの結果を確認できません。";
  } else {
    message = "本番デプロイは成功しましたが、GitHub Releaseの作成に失敗しています。";
  }
  return <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{message}</p>;
}

/** 版の説明（`.github/release-notes.md`）。取れなかったときは理由を出す（#4003） */
function ReleaseNotesView({
  notes,
  check,
}: {
  notes: ReleaseNotesSnapshot | undefined;
  check?: {
    target: { repoFullName: string; tagName: string };
    noteTagName: string;
    index: ReleaseCheckLineIndex;
    onToggle: (target: { repoFullName: string; tagName: string; lineKey: string }, checked: boolean) => void;
  };
}) {
  if (!notes || notes.status === "unavailable") {
    return (
      <p className="mt-1.5 rounded border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
        説明を取得できませんでした{notes ? `（${notes.reason}）` : ""}
      </p>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {notes.changes.map((change) => {
          if (!check) {
            return (
              <li key={change} className="text-xs leading-relaxed text-foreground/90">
                ・{change}
              </li>
            );
          }
          const lineTarget = { ...check.target, lineKey: carriedNoteLineKey(check.noteTagName, change) };
          const lineChecked = resolveReleaseCheckLineStatus(lineTarget, check.index) !== null;
          return (
            <li key={change} className="flex items-start gap-1.5 text-xs leading-relaxed text-foreground/90">
              <Checkbox
                checked={lineChecked}
                aria-label={`「${change}」を確認済みにする（参考）`}
                onCheckedChange={(next) => check.onToggle(lineTarget, next === true)}
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className={cn(lineChecked && "text-muted-foreground line-through")}>{change}</span>
            </li>
          );
        })}
      </ul>
      {notes.usage.length > 0 && (
        <div className="rounded bg-muted/50 px-2 py-1">
          <p className="text-[10.5px] font-semibold text-muted-foreground">使い方</p>
          <ul className="flex flex-col">
            {notes.usage.map((step) => (
              <li key={step} className="text-[11px] leading-relaxed text-foreground/80">
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** PRタイトルの箇条書き。`check`を渡したときだけ行チェック（#2982）を付ける */
function ReleaseLineList({
  heading,
  lines,
  repoFullName,
  onOpenPullRequest,
  check,
}: {
  heading?: string;
  lines: ReleaseHighlightLine[];
  repoFullName: string;
  onOpenPullRequest?: (pullRequestId: string) => void;
  check?: {
    target: { repoFullName: string; tagName: string };
    index: ReleaseCheckLineIndex;
    onToggle: (target: { repoFullName: string; tagName: string; lineKey: string }, checked: boolean) => void;
  };
}) {
  return (
    <div className="mt-1.5">
      {heading && <p className="mb-0.5 text-[10.5px] font-semibold text-muted-foreground">{heading}</p>}
      {lines.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">PRはありません</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {lines.map((line) => {
            const lineTarget = check ? { ...check.target, lineKey: line.key } : null;
            const lineChecked =
              check && lineTarget ? resolveReleaseCheckLineStatus(lineTarget, check.index) !== null : false;
            const pullRequestId = resolveReleasePullRequestId(line.key, repoFullName);
            return (
              <li key={line.key} className="flex items-start gap-1.5 text-xs leading-relaxed text-foreground/90">
                {check && lineTarget ? (
                  <Checkbox
                    checked={lineChecked}
                    aria-label={`「${line.text}」を確認済みにする（参考）`}
                    onCheckedChange={(next) => check.onToggle(lineTarget, next === true)}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                ) : (
                  <span aria-hidden className="shrink-0">・</span>
                )}
                {pullRequestId && onOpenPullRequest ? (
                  <button
                    type="button"
                    onClick={() => onOpenPullRequest(pullRequestId)}
                    title="Pull Requestの詳細を開く"
                    className={cn(
                      "cursor-pointer text-left underline-offset-2 hover:text-foreground hover:underline",
                      lineChecked && "text-muted-foreground line-through",
                    )}
                  >
                    {line.text}
                  </button>
                ) : (
                  <span className={cn(lineChecked && "text-muted-foreground line-through")}>{line.text}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 修正版が前の失敗版から引き継いだ変更（#4003）。この版で本番へ出たので、行チェックはこの版に付ける */
function CarriedReleaseSection({
  carried,
  repoFullName,
  target,
  checkLineIndex,
  onToggleCheckedLine,
  onOpenPullRequest,
  onJumpToRelease,
}: {
  carried: CarriedRelease;
  repoFullName: string;
  target: { repoFullName: string; tagName: string };
  checkLineIndex: ReleaseCheckLineIndex;
  onToggleCheckedLine: (
    target: { repoFullName: string; tagName: string; lineKey: string },
    checked: boolean,
  ) => void;
  onOpenPullRequest?: (pullRequestId: string) => void;
  onJumpToRelease: (target: { repoFullName: string; tagName: string }) => void;
}) {
  const { lines } = extractReleaseHighlights(carried.body, Number.POSITIVE_INFINITY);
  return (
    <section className="mt-2 rounded border-l-2 border-red-500/40 pl-2">
      <p className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-semibold text-muted-foreground">
        <JumpButton tagName={carried.tagName} onClick={() => onJumpToRelease({ repoFullName, tagName: carried.tagName })} />
        から引き継いだ変更
        <DeployStateBadge state={carried.deployState} />
      </p>
      <ReleaseNotesView
        notes={carried.releaseNotes}
        check={{ target, noteTagName: carried.tagName, index: checkLineIndex, onToggle: onToggleCheckedLine }}
      />
      {carried.body === null ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {carried.tagName}に含まれるPRの一覧を取得できませんでした
        </p>
      ) : (
        <ReleaseLineList
          heading={`${carried.tagName}に含まれるPR`}
          lines={lines}
          repoFullName={repoFullName}
          onOpenPullRequest={onOpenPullRequest}
          check={{ target, index: checkLineIndex, onToggle: onToggleCheckedLine }}
        />
      )}
    </section>
  );
}
