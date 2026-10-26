import { Loader2 } from "lucide-react";
import type React from "react";
import { formatMonthDayTime } from "@/lib/format-date-time";
import {
  JOURNEY_STATE_TEXT,
  type JourneyOwner,
  type JourneyState,
  type JourneyTone,
  type ReleaseJourney,
} from "@/lib/release-journey";
import { cn } from "@/lib/utils";

/**
 * 本番リリースの工程（#5076）。ブランチ画面（畳んだ行・次のリリース）・PR：本番リリース一覧・本番PR詳細で同じ部品を使う。
 *
 * 色と形の約束: 緑＝済み、紫＝自動で動いている、紫の点線＝自動で始まる、琥珀＝あなたの番、青緑の斜線＝修正中、
 * 赤＝直す必要がある、灰の斜線＋点線の枠＝取得不能（推測しない）、点線の枠＝対象外（分母から外す）。
 */
const SEGMENT_CLASS: Record<JourneyState, string> = {
  done: "bg-green-600 dark:bg-green-500",
  running: "animate-pulse bg-purple-600 motion-reduce:animate-none dark:bg-purple-500",
  waiting: "bg-[repeating-linear-gradient(90deg,#a855f7_0_3px,transparent_3px_6px)] opacity-70",
  user: "bg-amber-500",
  fixing: "bg-[repeating-linear-gradient(135deg,#0891b2_0_4px,rgba(8,145,178,0.35)_4px_8px)]",
  failed: "bg-destructive",
  unknown:
    "bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_2px,transparent_2px_5px)] outline-1 -outline-offset-1 outline-dashed outline-muted-foreground/60",
  todo: "bg-muted-foreground/20",
  skipped: "outline-1 -outline-offset-1 outline-dashed outline-border",
};

const TONE_CLASS: Record<JourneyTone, string> = {
  running: "font-semibold text-purple-700 dark:text-purple-300",
  waiting: "text-purple-700/80 dark:text-purple-300/80",
  user: "font-semibold text-amber-700 dark:text-amber-400",
  fixing: "font-semibold text-cyan-700 dark:text-cyan-300",
  failed: "font-semibold text-destructive",
  unknown: "text-muted-foreground",
};

const LABEL_CLASS: Record<JourneyState, string> = {
  ...TONE_CLASS,
  done: "text-foreground",
  todo: "text-muted-foreground",
  skipped: "text-muted-foreground/60",
};

const OWNER_TEXT: Record<Exclude<JourneyOwner, "none">, string> = { auto: "自動", user: "あなた" };

function ToneIcon({ tone }: { tone: JourneyState }) {
  if (tone === "running") return <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  if (tone === "waiting") return <span className="size-3 shrink-0 rounded-full border-2 border-dotted border-current" aria-hidden="true" />;
  const mark: Partial<Record<JourneyState, string>> = { user: "●", failed: "■", fixing: "✎", unknown: "?", done: "✓", skipped: "–" };
  return (
    <span aria-hidden="true" className="shrink-0 text-[10px] leading-none">
      {mark[tone] ?? "○"}
    </span>
  );
}

function describe(journey: ReleaseJourney): string {
  const head = journey.headline ? `：${journey.headline.label}` : "";
  const owner = journey.owner === "none" ? "" : `（担当: ${OWNER_TEXT[journey.owner]}）`;
  return `本番リリース${journey.candidateLabel ? ` ${journey.candidateLabel}` : ""} ${journey.done}/${journey.total}${head}${owner}`;
}

export function JourneyOwnerChip({ owner }: { owner: JourneyOwner }) {
  if (owner === "none") return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10.5px] leading-4 whitespace-nowrap",
        owner === "user"
          ? "border-amber-500 bg-amber-500/10 font-semibold text-amber-700 dark:text-amber-400"
          : "border-purple-500/50 text-purple-700 dark:text-purple-300",
      )}
      data-testid="release-journey-owner"
    >
      担当: {OWNER_TEXT[owner]}
    </span>
  );
}

/** 区切りだけの棒。**幅は固定**にして、横の文言の長さで行ごとに長さが変わらないようにする（#4930の要件を引き継ぐ） */
function Segments({ journey, className }: { journey: ReleaseJourney; className?: string }) {
  return (
    <span
      className={cn("grid shrink-0 gap-[3px]", className)}
      style={{ gridTemplateColumns: `repeat(${journey.steps.length}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {journey.steps.map((step) => (
        <span key={step.key} className={cn("h-1.5 rounded-sm", SEGMENT_CLASS[step.state])} title={`${step.label}: ${JOURNEY_STATE_TEXT[step.state]}`} />
      ))}
    </span>
  );
}

/** 畳んだ行・一覧の行に出す1行（候補名＋バー＋いまの工程＋担当＋件数＋並行する工程） */
export function ReleaseJourneyInline({ journey, showCandidate = true }: { journey: ReleaseJourney; showCandidate?: boolean }) {
  const { headline } = journey;
  return (
    <span
      role="img"
      aria-label={[describe(journey), ...journey.others].join("、")}
      title={headline?.title ?? undefined}
      className="flex min-w-0 max-w-full items-center gap-2 text-xs"
      data-testid="release-journey"
    >
      {showCandidate && journey.candidateLabel && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{journey.candidateLabel}</span>
      )}
      <Segments journey={journey} className="w-28 sm:w-[168px]" />
      {headline && (
        <span className={cn("inline-flex min-w-0 items-center gap-1", TONE_CLASS[headline.tone])}>
          <ToneIcon tone={headline.tone} />
          <span className="truncate">{headline.label}</span>
        </span>
      )}
      <JourneyOwnerChip owner={journey.owner} />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {journey.done}/{journey.total}
      </span>
      {journey.others.length > 0 && <span className="min-w-0 truncate text-[11px] text-muted-foreground">＋{journey.others.join("・")}</span>}
    </span>
  );
}

/** 区切りごとに工程名を添えたバーと、RC検証の内訳・作り直しの注記 */
export function ReleaseJourneySteps({ journey }: { journey: ReleaseJourney }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ol
        className="grid min-w-0 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${journey.steps.length}, minmax(0, 1fr))` }}
        aria-label={`本番リリースの工程 ${journey.done}/${journey.total}`}
        data-testid="release-journey-steps"
      >
        {journey.steps.map((step) => {
          const sub = step.status ?? (step.at ? formatMonthDayTime(step.at) : step.state === "skipped" ? "対象外" : null);
          return (
            <li
              key={step.key}
              className="flex min-w-0 flex-col gap-0.5"
              aria-label={`${step.label}: ${JOURNEY_STATE_TEXT[step.state]}${sub ? `（${sub}）` : ""}`}
              aria-current={step.state !== "done" && step.state !== "todo" && step.state !== "skipped" ? "step" : undefined}
              title={step.title ?? undefined}
            >
              <span className={cn("h-1.5 rounded-sm", SEGMENT_CLASS[step.state])} aria-hidden="true" />
              <span className={cn("truncate text-[10.5px] leading-tight", LABEL_CLASS[step.state])} aria-hidden="true">
                {step.state === "done" && "✓ "}
                {step.label}
              </span>
              {sub && (
                <span className="truncate text-[10px] leading-tight text-muted-foreground tabular-nums" aria-hidden="true">
                  {sub}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {journey.checks && (
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]" data-testid="release-journey-checks">
          <span className="text-muted-foreground">RC検証:</span>
          {journey.checks.map((check) => (
            <span
              key={check.key}
              className={cn("inline-flex min-w-0 items-center gap-1 rounded-full border bg-muted/40 px-2", LABEL_CLASS[check.state])}
              title={check.title ?? undefined}
            >
              <ToneIcon tone={check.state} />
              <span className="truncate">{check.state === "done" || check.state === "todo" || check.state === "skipped" ? `${check.label}${check.state === "skipped" ? " 対象外" : ""}` : (check.status ?? check.label)}</span>
            </span>
          ))}
        </p>
      )}
      {journey.predecessor && (
        <p className="border-l-2 pl-2 text-[11px] text-muted-foreground" data-testid="release-journey-predecessor">
          {journey.predecessor}
        </p>
      )}
    </div>
  );
}

/**
 * 「いま・担当・次」の枠。主操作は呼び出し側が1つだけ渡し、ほかは`more`（その他の操作）へ置く。
 * 取得に失敗して古い情報を出しているときは点線の枠と最終更新の行で示す
 */
export function ReleaseJourneyNow({
  journey,
  action,
  more,
  link,
  fetchedAt,
}: {
  journey: ReleaseJourney;
  action?: React.ReactNode;
  more?: React.ReactNode;
  link?: React.ReactNode;
  /** 画面が最後に取得できた時刻（ISO8601） */
  fetchedAt?: string | null;
}) {
  const { headline } = journey;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border-2 px-2.5 py-2 text-xs",
        journey.stale ? "border-dashed border-muted-foreground/60" : "border-primary/50",
      )}
      data-testid="release-journey-now"
    >
      <dl className="grid min-w-0 grid-cols-[3.6em_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">いま</dt>
        <dd className="min-w-0">
          {headline ? (
            <span className={cn("inline-flex min-w-0 items-start gap-1 break-words", TONE_CLASS[headline.tone])}>
              <span className="pt-[3px]">
                <ToneIcon tone={headline.tone} />
              </span>
              <span>{headline.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">動いている工程はありません</span>
          )}
          {headline?.title && <span className="block break-words text-muted-foreground">{headline.title}</span>}
          {journey.others.length > 0 && (
            <span className="block break-words text-muted-foreground">並行して: {journey.others.join("・")}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">担当</dt>
        <dd>{journey.owner === "none" ? <span className="text-muted-foreground">—</span> : <JourneyOwnerChip owner={journey.owner} />}</dd>
        {journey.next && (
          <>
            <dt className="text-muted-foreground">次</dt>
            <dd className="min-w-0 break-words">{journey.next}</dd>
          </>
        )}
      </dl>
      {(action || more || link) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {action}
          {link}
          {more}
        </div>
      )}
      {(journey.updatedAt || fetchedAt || journey.stale) && (
        <p className={cn("text-[11px]", journey.stale ? "text-destructive" : "text-muted-foreground")} data-testid="release-journey-updated">
          {journey.stale
            ? `最新の状態を取得できません${fetchedAt ? `（${formatMonthDayTime(fetchedAt)} 時点の情報）` : ""}`
            : [journey.updatedAt && `記録の更新 ${formatMonthDayTime(journey.updatedAt)}`, fetchedAt && `${formatMonthDayTime(fetchedAt)} 時点`]
                .filter(Boolean)
                .join("・")}
        </p>
      )}
    </div>
  );
}

/** 主操作以外を畳んで置く「その他の操作」。中身が無ければ出さない */
export function JourneyMoreActions({ children, count }: { children: React.ReactNode; count: number }) {
  if (count === 0) return null;
  return (
    <details className="min-w-0 text-xs" data-testid="release-journey-more">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">その他の操作（{count}）</summary>
      <div className="mt-1.5 flex min-w-0 flex-col items-start gap-1.5">{children}</div>
    </details>
  );
}
