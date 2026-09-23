"use client";

import { CalendarClock, Hourglass, Loader2, RefreshCw, Timer, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScheduledRunSettingsPatch } from "@/hooks/use-nightly-run";
import { useNow } from "@/hooks/use-now";
import {
  BULK_RESERVE_MODEL_GROUPS,
  NEXT_WINDOW_RUN_FLOOR_PERCENT_OPTIONS,
  NEXT_WINDOW_RUN_INTERVAL_MINUTES_OPTIONS,
  NEXT_WINDOW_RUN_LEAD_MINUTES_OPTIONS,
  describeClaudeModel,
  parseClaudeLocalModel,
} from "@/lib/app-settings";
import {
  describeClaudeWindowKeepAlive,
  formatClaudeWindowKeepAliveHour,
  type ClaudeWindowKeepAliveView,
} from "@/lib/claude-window-keepalive";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { formatMonthDay, formatTimeOfDay } from "@/lib/format-date-time";
import { formatResetCountdown } from "@/lib/format-reset";
import { START_IMPLEMENTATION_OPTIONS } from "@/lib/github/start-implementation";
import {
  NIGHTLY_RUN_OUTCOME_DESCRIPTIONS,
  NIGHTLY_RUN_OUTCOME_LABELS,
  NIGHTLY_RUN_OUTCOME_ORDER,
  summarizeNightlyRunOutcomes,
  type NightlyRunEntryView,
  type NightlyRunOutcomeKind,
  type NightlyRunState,
} from "@/lib/nightly-run";
import {
  describeNextWindowRunSchedule,
  formatNextWindowRunKeyLabel,
  type NextWindowRunSettings,
  type NextWindowRunWindowView,
} from "@/lib/next-window-run";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";

/**
 * 「予約実行」画面（#2995）。**積んで、あとで起きる予定をまとめる。**
 *
 * 「次の5時間枠」（Claudeのプラン枠のリセット時刻で決まる窓）に積んだ予定を、
 * 「予定 → 直近1回の結果（5分類）」の形で並べる（かつては「今夜の夜間実行」も同じ形で
 * 並べていたが#3019で削除した）。その上に、予定を持たない設定だけの節「5時間枠を開けておく」
 * （#3032）を置く。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`release-history-panel.tsx`と同じ切り分け）。
 * 設定（有効／無効・残り時間・間隔）も節の中に置き、**切り替えた時点で保存する**
 * （設定ダイアログの「実行設定」には載せない。あちらは保存ボタンを押すまで効かない値の区分）。
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
  onUpdateSettings: (patch: ScheduledRunSettingsPatch) => void;
  /** Issue詳細を開く（シェルの`openUsageIssue`と同じ引き当て。同期済みのIssueが無ければ何も起きない） */
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h2 className="flex items-center gap-1.5 text-sm font-bold">
            <CalendarClock className="size-4" aria-hidden />
            予約実行
          </h2>
          <p className="text-[11px] text-muted-foreground">
            積んだIssueは、窓が開いた時点でサブPCの巡回が順に起動します
          </p>
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

      {!state ? (
        <>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : (
        <>
          <ClaudeWindowMeter window={state.nextWindow.window} settings={state.nextWindow.settings} />

          <KeepAliveSection
            keepAlive={state.keepAlive}
            compact={compact}
            isSubmitting={isSubmitting}
            onUpdateSettings={onUpdateSettings}
          />

          <ScheduleSection
            icon={<Hourglass className="size-3.5" aria-hidden />}
            title="次の5時間枠"
            scheduleLine={describeNextWindowRunSchedule(
              state.nextWindow.settings,
              state.nextWindow.window,
            )}
            badge={
              state.nextWindow.window?.quotaBlock && state.nextWindow.settings.enabled ? (
                <span className="rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  起動を見送り中
                </span>
              ) : null
            }
            settings={
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3">
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    <Checkbox
                      checked={state.nextWindow.settings.enabled}
                      disabled={isSubmitting}
                      onCheckedChange={(checked) =>
                        onUpdateSettings({ nextWindow: { enabled: checked === true } })
                      }
                    />
                    <span>次の5時間枠での実行を有効にする</span>
                  </label>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>起動する残り時間</span>
                    <Select
                      value={String(state.nextWindow.settings.leadMinutes)}
                      disabled={isSubmitting}
                      onValueChange={(value) =>
                        onUpdateSettings({ nextWindow: { leadMinutes: Number(value) } })
                      }
                    >
                      <SelectTrigger size="sm" className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NEXT_WINDOW_RUN_LEAD_MINUTES_OPTIONS.map((minutes) => (
                          <SelectItem key={minutes} value={String(minutes)}>
                            {minutes}分
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>起動の間隔</span>
                    <Select
                      value={String(state.nextWindow.settings.intervalMinutes)}
                      disabled={isSubmitting}
                      onValueChange={(value) =>
                        onUpdateSettings({ nextWindow: { intervalMinutes: Number(value) } })
                      }
                    >
                      <SelectTrigger size="sm" className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NEXT_WINDOW_RUN_INTERVAL_MINUTES_OPTIONS.map((minutes) => (
                          <SelectItem key={minutes} value={String(minutes)}>
                            {minutes === 0 ? "空けない" : `${minutes}分`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <FloorSettings
                  settings={state.nextWindow.settings}
                  compact={compact}
                  isSubmitting={isSubmitting}
                  onUpdateSettings={onUpdateSettings}
                />
                <BulkModelSettings
                  settings={state.nextWindow.settings}
                  compact={compact}
                  isSubmitting={isSubmitting}
                  onUpdateSettings={onUpdateSettings}
                />
              </div>
            }
            hint={
              !compact && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  5時間枠の残りが{state.nextWindow.settings.leadMinutes}
                  分を切ってから、1件ずつ起動します。残りが下限を下回っている枠があるあいだは見送ります。セッションは枠のリセットをまたいで走るので、
                  <strong className="font-semibold text-foreground">
                    次の5時間枠のカウントがその時点から始まります
                  </strong>
                  。枠が動いていないときは待たずに起動します（起動そのものが枠の開始になるため）。
                </p>
              )
            }
            emptyText="予定はありません。Issue詳細の「実装を開始」で実行先に「次の5時間枠」を選ぶと、ここに並びます。"
            resultsTitle={
              state.nextWindow.results
                ? `${formatNextWindowRunKeyLabel(state.nextWindow.results.runKey)}の枠の結果`
                : "前回の結果"
            }
            queued={state.nextWindow.queued}
            results={state.nextWindow.results?.entries ?? null}
            compact={compact}
            isSubmitting={isSubmitting}
            onCancel={onCancel}
            onOpenIssue={onOpenIssue}
          />
        </>
      )}
    </div>
  );
}

/**
 * いまのClaude 5時間枠と週間枠。**「AI使用量」画面と同じ値**（`/api/claude/usage`）で、ここでは
 * 予約の起動時刻と、残り枠の下限（#3100）に触れているかを読むために出す。取りに行っていない
 * （次枠実行がOFFで予定も無い）ときは出さない。
 */
function ClaudeWindowMeter({
  window,
  settings,
}: {
  window: NextWindowRunWindowView | null;
  settings: NextWindowRunSettings;
}) {
  // 残り時間の表示だけは時計に依る（`useNow`。取り直しの間隔は`useNightlyRun`と同じ30秒）。
  // **描画中に`Date.now()`を読まない**（`react-hooks/purity`）
  const now = useNow();
  if (!window) return null;
  if (window.phase === "unknown") {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        Claudeの5時間枠の状況を取得できていません。取得できるまで次枠実行は起動しません。
      </p>
    );
  }

  // `useNow`は最初の描画で`null`を返す（サーバーとクライアントで時刻がずれないようにするため）。
  // その間はカウントダウンを出さず、絶対時刻だけを出す
  const countdown =
    window.resetsAt && now !== null
      ? formatResetCountdown(new Date(window.resetsAt).getTime() / 1000, now)
      : null;
  const fiveHourText =
    (window.phase === "idle"
      ? "枠は動いていません"
      : window.resetsAt
        ? `${formatTimeOfDay(window.resetsAt)}にリセット${countdown ? `（${countdown}）` : ""}`
        : "") +
    (window.opensAt && window.phase === "waiting"
      ? ` ・ ${formatTimeOfDay(window.opensAt)}から起動`
      : "");
  const weeklyText = window.weeklyResetsAt
    ? `${formatMonthDay(window.weeklyResetsAt)} ${formatTimeOfDay(window.weeklyResetsAt)}にリセット`
    : "";
  const showFloorLegend =
    settings.fiveHourFloorPercent > 0 ||
    (window.weeklyUsedPercent !== null && settings.weeklyFloorPercent > 0);

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3">
      <QuotaMeterRow
        label="いまの5時間枠"
        usedPercent={window.usedPercent}
        floorPercent={settings.fiveHourFloorPercent}
        blocked={window.quotaBlock?.window === "fiveHour"}
        text={fiveHourText}
      />
      {window.weeklyUsedPercent !== null && (
        <QuotaMeterRow
          label="週間枠"
          usedPercent={window.weeklyUsedPercent}
          floorPercent={settings.weeklyFloorPercent}
          blocked={window.quotaBlock?.window === "weekly"}
          text={weeklyText}
        />
      )}
      {showFloorLegend && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className="inline-block h-2 w-3.5 border-l-2 border-amber-500"
            style={FLOOR_ZONE_STYLE}
            aria-hidden
          />
          斜線は下限を下回る範囲です。ここに入っている間は起動しません
        </p>
      )}
    </div>
  );
}

/** 下限を下回る範囲（バーの右端から`floorPercent`ぶん）の斜線 */
const FLOOR_ZONE_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgb(245 158 11 / 0.3) 0 3px, transparent 3px 6px)",
} as const;

function QuotaMeterRow({
  label,
  usedPercent,
  floorPercent,
  blocked,
  text,
}: {
  label: string;
  usedPercent: number | null;
  floorPercent: number;
  blocked: boolean;
  text: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-20 text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold tabular-nums">
        {usedPercent === null ? "—" : `${Math.round(usedPercent)}%`}
      </span>
      <div className="relative h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", blocked ? "bg-amber-500" : "bg-primary")}
          style={{ width: `${Math.min(100, Math.max(0, usedPercent ?? 0))}%` }}
        />
        {floorPercent > 0 && (
          <div
            className="absolute inset-y-0 right-0 border-l-2 border-amber-500"
            style={{ ...FLOOR_ZONE_STYLE, width: `${floorPercent}%` }}
            aria-hidden
          />
        )}
      </div>
      <span className="basis-full text-[11px] text-muted-foreground">{text}</span>
    </div>
  );
}

/**
 * 一覧の「まとめて予約」を開いたとき最初に選ばれているモデル（#3438）。Claude CodeとCodexの両方から
 * 選べ、「設定に従う」なら`claudeLocalModel`・`codexModel`の設定へ委ねる。切り替えた時点で保存する。
 */
function BulkModelSettings({
  settings,
  compact,
  isSubmitting,
  onUpdateSettings,
}: {
  settings: NextWindowRunSettings;
  compact: boolean;
  isSubmitting: boolean;
  onUpdateSettings: (patch: ScheduledRunSettingsPatch) => void;
}) {
  const value = settings.bulkModel ? settings.bulkModel : FOLLOW_SETTINGS;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-[13px] font-semibold">一括予約の初期モデル</span>
      <Select
        value={value}
        disabled={isSubmitting}
        onValueChange={(next) =>
          onUpdateSettings({ nextWindow: { bulkModel: next === FOLLOW_SETTINGS ? "" : next } })
        }
      >
        <SelectTrigger size="sm" className="w-56" aria-label="一括予約の初期モデル">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_SETTINGS}>設定に従う</SelectItem>
          {BULK_RESERVE_MODEL_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {!compact && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Issue一覧の「まとめて予約」を開いたときに最初から選ばれるモデルです。予約のたびにバーで変えられます。
          Codexを選ぶと、Codexを使えるサブPCのあるリポジトリだけ選べます。
        </p>
      )}
    </div>
  );
}

/** Radixの`SelectItem`は空文字を値にできないため、「設定に従う」だけこの語で表す */
const FOLLOW_SETTINGS = "follow-settings";

/**
 * 起動しない残り枠の下限（#3100）。**次枠実行の設定の一部**で、切り替えた時点で保存する。
 * 選ぶのは「残りがこの値を下回っている間は起動を見送る」ライン（0は制限しない）。
 */
function FloorSettings({
  settings,
  compact,
  isSubmitting,
  onUpdateSettings,
}: {
  settings: NextWindowRunSettings;
  compact: boolean;
  isSubmitting: boolean;
  onUpdateSettings: (patch: ScheduledRunSettingsPatch) => void;
}) {
  const floorSelect = (
    value: number,
    key: "fiveHourFloorPercent" | "weeklyFloorPercent",
    label: string,
  ) => (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <Select
        value={String(value)}
        disabled={isSubmitting}
        onValueChange={(next) => onUpdateSettings({ nextWindow: { [key]: Number(next) } })}
      >
        <SelectTrigger size="sm" className="w-28" aria-label={`${label}の下限`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NEXT_WINDOW_RUN_FLOOR_PERCENT_OPTIONS.map((percent) => (
            <SelectItem key={percent} value={String(percent)}>
              {percent === 0 ? "制限しない" : `${percent}%`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-[13px] font-semibold">起動しない残り枠の下限</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {floorSelect(settings.fiveHourFloorPercent, "fiveHourFloorPercent", "5時間枠")}
        {floorSelect(settings.weeklyFloorPercent, "weeklyFloorPercent", "週間枠")}
      </div>
      {!compact && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          残りが下限を
          <strong className="font-semibold text-foreground">下回っている間</strong>
          は起動を見送り、上回れば次の巡回で再開します。5時間枠は「いまの枠を多く使っている＝作業中」
          とみなして起こさない目安、週間枠は週の残りを取っておく目安です。見送りが24時間を超えた予定は
          「見送り」になります（週間枠のリセットまで数日あるときなど）。
        </p>
      )}
    </div>
  );
}

const KEEP_ALIVE_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * 5時間枠を開けておく（#3032）。**予定を持たない設定だけの節**なので、`ScheduleSection`には載せない。
 * 次枠実行と同じく切り替えた時点で保存する。
 */
function KeepAliveSection({
  keepAlive,
  compact,
  isSubmitting,
  onUpdateSettings,
}: {
  keepAlive: ClaudeWindowKeepAliveView;
  compact: boolean;
  isSubmitting: boolean;
  onUpdateSettings: (patch: ScheduledRunSettingsPatch) => void;
}) {
  const { settings } = keepAlive;
  const hourSelect = (value: number, key: "startHour" | "endHour", label: string) => (
    <Select
      value={String(value)}
      disabled={isSubmitting}
      onValueChange={(next) => onUpdateSettings({ keepAlive: { [key]: Number(next) } })}
    >
      <SelectTrigger size="sm" className="w-20" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {KEEP_ALIVE_HOUR_OPTIONS.map((hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {formatClaudeWindowKeepAliveHour(hour)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Timer className="size-3.5" aria-hidden />
          5時間枠を開けておく
        </h3>
        <p className="text-[11px] text-muted-foreground">{describeClaudeWindowKeepAlive(keepAlive)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3">
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <Checkbox
            checked={settings.enabled}
            disabled={isSubmitting}
            onCheckedChange={(checked) => onUpdateSettings({ keepAlive: { enabled: checked === true } })}
          />
          <span>枠が止まっていたら自動で開ける</span>
        </label>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>時間帯</span>
          {hourSelect(settings.startHour, "startHour", "開始時刻")}
          <span>〜</span>
          {hourSelect(settings.endHour, "endHour", "終了時刻")}
        </div>
      </div>

      {settings.enabled && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {!keepAlive.withinHours ? (
            <span className="rounded-full bg-muted px-2 py-px font-medium">時間帯の外</span>
          ) : keepAlive.runningUntil ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-px font-medium text-emerald-700 dark:text-emerald-400">
              枠は動いています
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-px font-medium">枠は止まっています</span>
          )}
          <span>
            最後に開けた時刻{" "}
            {keepAlive.probedAt ? (
              <span className="font-mono tabular-nums">{formatTimeOfDay(keepAlive.probedAt)}</span>
            ) : (
              "—"
            )}
          </span>
        </div>
      )}

      {!compact && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          5時間枠は最初のリクエストで始まります。作業の前に枠を開けておくと、上限に当たっても
          <strong className="font-semibold text-foreground">リセットまでの待ちが短く</strong>
          なります。
          <strong className="font-semibold text-foreground">週間枠の総量は増えません</strong>
          。送るのは1トークンのリクエストで、消費は「AI使用量」の「プラン枠の取得」に計上されます。
        </p>
      )}
    </section>
  );
}

/** 1つの節（予定 → 直近の結果） */
function ScheduleSection({
  icon,
  title,
  scheduleLine,
  badge,
  settings,
  hint,
  emptyText,
  resultsTitle,
  queued,
  results,
  compact,
  isSubmitting,
  onCancel,
  onOpenIssue,
}: {
  icon: ReactNode;
  title: string;
  scheduleLine: string;
  /** 見出しの右に添える状態の印（見送り中など）。無ければnull */
  badge?: ReactNode;
  settings: ReactNode;
  hint?: ReactNode;
  emptyText: string;
  resultsTitle: string;
  queued: NightlyRunEntryView[];
  results: NightlyRunEntryView[] | null;
  compact: boolean;
  isSubmitting: boolean;
  onCancel: (entryId: string) => void;
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          {icon}
          {title}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {queued.length}件・積んだ順に起動
          </span>
          {badge}
        </h3>
        <p className="text-[11px] text-muted-foreground">{scheduleLine}</p>
      </div>

      {settings}
      {hint}

      {queued.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {queued.map((entry) => (
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

      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold">
          {resultsTitle}
          {results && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {results.length}件
            </span>
          )}
        </h4>
      </div>
      {!results ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          まだ一度も走っていません。
        </p>
      ) : (
        <ResultsSection entries={results} compact={compact} onOpenIssue={onOpenIssue} />
      )}
    </section>
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
          title="予定から外す"
        >
          <X className="size-3" aria-hidden />
          取り消す
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-px">{formatDispatchHostName(entry.targetHost)}</span>
        {entry.claudeModel && <span className="rounded-full bg-muted px-2 py-px">{claudeModelLabel(entry.claudeModel)}</span>}
        {entry.agent !== "claude" && <span className="rounded-full bg-muted px-2 py-px">{entry.agent}</span>}
        {entry.codexModel && <span className="rounded-full bg-muted px-2 py-px">{entry.codexModel}</span>}
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

/** 予定の行に出すClaudeのモデル名。未知の値は生の値のまま出す */
function claudeModelLabel(model: string): string {
  const parsed = parseClaudeLocalModel(model);
  return parsed ? describeClaudeModel(parsed) : model;
}

/** 予定の行に添える、起動した後どうなるかの見込み */
function QueuedHint({ entry }: { entry: NightlyRunEntryView }) {
  if (entry.optionLabels.includes("21.plan-required")) {
    return <span>→ 計画の投稿で止まり、承認は人が行う</span>;
  }
  if (entry.optionLabels.includes("22.merge-confirm-required")) {
    return <span>→ 「確認が必要」で止まる予定</span>;
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

