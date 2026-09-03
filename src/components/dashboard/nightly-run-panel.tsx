"use client";

import { Loader2, Moon, RefreshCw, X } from "lucide-react";
import { useMemo } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NIGHTLY_RUN_START_HOUR_OPTIONS } from "@/lib/app-settings";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { formatTimeOfDay } from "@/lib/format-date-time";
import { START_IMPLEMENTATION_OPTIONS } from "@/lib/github/start-implementation";
import {
  NIGHTLY_RUN_OUTCOME_DESCRIPTIONS,
  NIGHTLY_RUN_OUTCOME_LABELS,
  NIGHTLY_RUN_OUTCOME_ORDER,
  describeNightlyRunWindowHours,
  formatNightlyRunHour,
  summarizeNightlyRunOutcomes,
  type NightlyRunEntryView,
  type NightlyRunOutcomeKind,
  type NightlyRunSettings,
  type NightlyRunState,
} from "@/lib/nightly-run";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";

/**
 * 「夜間実行」画面（#2772）。今夜の予定と、直近の夜の結果（5分類）を1画面に置く。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`release-history-panel.tsx`と同じ切り分け）。
 * 設定（有効／無効・開始時刻）も右上に置き、**切り替えた時点で保存する**（設定ダイアログの
 * 「実行設定」には載せない。あちらは保存ボタンを押すまで効かない値の区分）。
 */
export function NightlyRunPanel({
  state,
  isLoading,
  error,
  isSubmitting,
  onRefresh,
  onCancel,
  onUpdateSettings,
  onOpenIssue,
  compact = false,
  className,
}: {
  state: NightlyRunState | null;
  isLoading: boolean;
  error: string | null;
  isSubmitting: boolean;
  onRefresh: () => void;
  onCancel: (entryId: string) => void;
  onUpdateSettings: (patch: Partial<NightlyRunSettings>) => void;
  /** Issue詳細を開く（シェルの`openUsageIssue`と同じ引き当て。同期済みのIssueが無ければ何も起きない） */
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h2 className="flex items-center gap-1.5 text-sm font-bold">
            <Moon className="size-4" aria-hidden />
            夜間実行
          </h2>
          {state && <ScheduleLine state={state} compact={compact} />}
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

      <ApiErrorMessage message={error} />

      {state ? (
        <SettingsRow settings={state.settings} isSubmitting={isSubmitting} onUpdate={onUpdateSettings} />
      ) : (
        <Skeleton className="h-9 w-full" />
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold">
            今夜の予定
            {state && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {state.queued.length}件・積んだ順に起動
              </span>
            )}
          </h3>
        </div>
        {!state ? (
          <Skeleton className="h-16 w-full" />
        ) : state.queued.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            予定はありません。Issue詳細の「実装を開始」で実行先に「今夜の夜間実行」を選ぶと、ここに並びます。
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {state.queued.map((entry) => (
              <QueuedRow
                key={entry.id}
                entry={entry}
                compact={compact}
                isSubmitting={isSubmitting}
                onCancel={() => onCancel(entry.id)}
                onOpenIssue={onOpenIssue}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold">
            {state?.results ? `${formatNightKey(state.results.nightKey)}の夜の結果` : "前の夜の結果"}
            {state?.results && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {state.results.entries.length}件
              </span>
            )}
          </h3>
          {!compact && state?.results && (
            <span className="text-[11px] text-muted-foreground">結果は次の夜間実行が始まるまで残ります</span>
          )}
        </div>
        {!state ? (
          <Skeleton className="h-24 w-full" />
        ) : !state.results ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            まだ一度も走っていません。
          </p>
        ) : (
          <ResultsSection entries={state.results.entries} compact={compact} onOpenIssue={onOpenIssue} />
        )}
      </section>
    </div>
  );
}

function ScheduleLine({ state, compact }: { state: NightlyRunState; compact: boolean }) {
  const { settings, window } = state;
  const hour = formatNightlyRunHour(settings.startHour);
  if (!settings.enabled) {
    return (
      <p className="text-[11px] text-muted-foreground">
        夜間実行はOFFです。積んだIssueはONにした夜の{hour}から起動します。
      </p>
    );
  }
  if (window.isOpen) {
    return (
      <p className="text-[11px] text-muted-foreground">
        実行時間内（{describeNightlyRunWindowHours(settings.startHour)}）です。予定はサブPCの巡回のたびに順に起動します。
      </p>
    );
  }
  return (
    <p className="text-[11px] text-muted-foreground">
      次は {formatTimeOfDay(window.nextStartsAt)} に開始
      {compact ? "" : "します。同時に走る本数は実行設定の「サブPCの同時実行数」に従い、空くたびに次のIssueへ進みます"}
    </p>
  );
}

function SettingsRow({
  settings,
  isSubmitting,
  onUpdate,
}: {
  settings: NightlyRunSettings;
  isSubmitting: boolean;
  onUpdate: (patch: Partial<NightlyRunSettings>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <Checkbox
          checked={settings.enabled}
          disabled={isSubmitting}
          onCheckedChange={(checked) => onUpdate({ enabled: checked === true })}
        />
        <span>夜間実行を有効にする</span>
      </label>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>開始時刻</span>
        <Select
          value={String(settings.startHour)}
          disabled={isSubmitting}
          onValueChange={(value) => onUpdate({ startHour: Number(value) })}
        >
          <SelectTrigger size="sm" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NIGHTLY_RUN_START_HOUR_OPTIONS.map((hour) => (
              <SelectItem key={hour} value={String(hour)}>
                {formatNightlyRunHour(hour)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>（日本時間・3時間のあいだ起動を試みます）</span>
      </div>
    </div>
  );
}

function optionLabelTitle(name: string): string {
  return START_IMPLEMENTATION_OPTIONS.find((option) => option.githubLabel === name)?.label ?? name;
}

function IssueTitle({
  entry,
  onOpenIssue,
}: {
  entry: NightlyRunEntryView;
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
}) {
  const repoName = entry.repositoryFullName.split("/")[1] ?? entry.repositoryFullName;
  const color = getRepoColor(entry.repositoryFullName);
  const title = entry.issueTitle ?? `#${entry.issueNumber}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] text-muted-foreground"
        title={entry.repositoryFullName}
      >
        <span className={cn("size-1.5 rounded-full", color)} aria-hidden />
        {repoName}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        #{entry.issueNumber}
      </span>
      <button
        type="button"
        onClick={() => onOpenIssue(entry.repositoryFullName, entry.issueNumber)}
        className="min-w-0 truncate text-left text-[13px] font-medium hover:underline"
        title={title}
      >
        {title}
      </button>
    </div>
  );
}

function QueuedRow({
  entry,
  compact,
  isSubmitting,
  onCancel,
  onOpenIssue,
}: {
  entry: NightlyRunEntryView;
  compact: boolean;
  isSubmitting: boolean;
  onCancel: () => void;
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <IssueTitle entry={entry} onOpenIssue={onOpenIssue} />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={isSubmitting}
          onClick={onCancel}
          title="今夜の予定から外す"
        >
          <X className="size-3" aria-hidden />
          取り消す
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-px">{formatDispatchHostName(entry.targetHost)}</span>
        {entry.claudeModel && <span className="rounded-full bg-muted px-2 py-px">{entry.claudeModel}</span>}
        {entry.agent !== "claude" && <span className="rounded-full bg-muted px-2 py-px">{entry.agent}</span>}
        {entry.optionLabels.map((name) => (
          <span key={name} className="rounded-full bg-primary/10 px-2 py-px text-primary">
            {optionLabelTitle(name)}
          </span>
        ))}
        {!compact && <QueuedHint entry={entry} />}
      </div>
    </li>
  );
}

/** 予定の行に添える、朝にどうなるかの見込み */
function QueuedHint({ entry }: { entry: NightlyRunEntryView }) {
  if (entry.optionLabels.includes("21.plan-required")) {
    return <span>→ 夜は計画の投稿で止まり、承認は朝に</span>;
  }
  if (entry.optionLabels.includes("22.merge-confirm-required")) {
    return <span>→ 朝には「確認が必要」で止まる予定</span>;
  }
  return <span>→ PR作成・自動レビュー・developマージまで進む</span>;
}

const OUTCOME_STYLES: Record<NightlyRunOutcomeKind, { pill: string; dot: string; count: string }> = {
  ok: {
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
    count: "text-emerald-700 dark:text-emerald-400",
  },
  warn: {
    pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    count: "text-amber-700 dark:text-amber-400",
  },
  run: {
    pill: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
    count: "text-blue-700 dark:text-blue-400",
  },
  bad: {
    pill: "bg-red-500/15 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
    count: "text-red-700 dark:text-red-400",
  },
  skip: {
    pill: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
    count: "text-muted-foreground",
  },
};

function OutcomePill({ kind }: { kind: NightlyRunOutcomeKind }) {
  const style = OUTCOME_STYLES[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-px text-[11px] font-medium",
        style.pill,
      )}
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
      {NIGHTLY_RUN_OUTCOME_LABELS[kind]}
    </span>
  );
}

function ResultsSection({
  entries,
  compact,
  onOpenIssue,
}: {
  entries: NightlyRunEntryView[];
  compact: boolean;
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
}) {
  const counts = useMemo(() => summarizeNightlyRunOutcomes(entries), [entries]);
  const groups = useMemo(
    () =>
      NIGHTLY_RUN_OUTCOME_ORDER.map((kind) => ({
        kind,
        entries: entries.filter((entry) => entry.outcome?.kind === kind),
      })).filter((group) => group.entries.length > 0),
    [entries],
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 要約。**実行中は枠に出さない**——朝に見るとき「決まったもの」の数だけ並べる。
          実行中のぶんは下の一覧に出る */}
      <div className="grid grid-cols-4 divide-x rounded-lg border">
        {(["ok", "warn", "bad", "skip"] as const).map((kind) => (
          <div key={kind} className={cn("flex flex-col px-3 py-2", compact && "px-2")}>
            <span
              className={cn(
                "font-mono text-xl font-bold tabular-nums leading-tight",
                compact && "text-lg",
                OUTCOME_STYLES[kind].count,
              )}
            >
              {counts[kind]}
            </span>
            <span className={cn("text-[11px] text-muted-foreground", compact && "text-[10px]")}>
              {NIGHTLY_RUN_OUTCOME_LABELS[kind]}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-lg border">
        {groups.map((group, index) => (
          <div key={group.kind} className={cn(index > 0 && "border-t")}>
            <div className="flex items-center gap-2 bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground">
              <OutcomePill kind={group.kind} />
              {!compact && <span>{NIGHTLY_RUN_OUTCOME_DESCRIPTIONS[group.kind]}</span>}
            </div>
            <ul className="divide-y">
              {group.entries.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1 px-3 py-2">
                  <IssueTitle entry={entry} onOpenIssue={onOpenIssue} />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    {entry.resolvedAt && (
                      <span className="font-mono tabular-nums">{formatTimeOfDay(entry.resolvedAt)}</span>
                    )}
                    {entry.outcome && (
                      <span className={cn(group.kind === "warn" || group.kind === "bad" ? "text-foreground" : "")}>
                        {entry.outcome.detail}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** `2026-09-02` → `9/2（火）` */
function formatNightKey(nightKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nightKey);
  if (!match) return nightKey;
  const date = new Date(`${nightKey}T00:00:00+09:00`);
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][jstWeekday(date)];
  return `${Number(match[2])}/${Number(match[3])}（${weekday}）`;
}

function jstWeekday(date: Date): number {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDay();
}
