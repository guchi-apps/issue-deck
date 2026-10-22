import { Loader2 } from "lucide-react";
import type { ReleaseTrack, ReleaseTrackStepState, ReleaseTrackTone } from "@/lib/release-progress-track";
import { cn } from "@/lib/utils";

/**
 * 本番リリースの進行バー（#4930）。区切りの形はiOS配布の段階バー（`ios-distribution-stage-bar.tsx`）にそろえ、
 * 色はこの画面の約束に合わせる（緑＝済み・紫＝待てば進む・琥珀＝あなたの番・赤＝直す必要がある）。
 * iOSのバーは成功を青にしているので、部品は分けている。
 */
const SEGMENT_CLASS: Record<ReleaseTrackStepState, string> = {
  done: "bg-green-600 dark:bg-green-500",
  running: "animate-pulse bg-purple-600 motion-reduce:animate-none dark:bg-purple-500",
  // 点線で「自動で始まるのを待っている」ことを形で出す（実行中の無地と区別する）
  waiting:
    "bg-[repeating-linear-gradient(90deg,#a855f7_0_3px,transparent_3px_6px)] opacity-70",
  user: "bg-amber-500",
  failed: "bg-destructive",
  todo: "bg-muted-foreground/20",
  skipped:
    "bg-[repeating-linear-gradient(90deg,var(--color-border)_0_3px,transparent_3px_6px)]",
};

const STATE_TEXT: Record<ReleaseTrackStepState, string> = {
  done: "済み",
  running: "実行中",
  waiting: "開始待ち",
  user: "操作待ち",
  failed: "失敗・要確認",
  todo: "まだ",
  skipped: "対象外",
};

const TONE_CLASS: Record<ReleaseTrackTone, string> = {
  running: "font-semibold text-purple-700 dark:text-purple-300",
  waiting: "text-muted-foreground",
  user: "font-semibold text-amber-700 dark:text-amber-400",
  failed: "font-semibold text-destructive",
};

function ToneIcon({ tone }: { tone: ReleaseTrackTone }) {
  if (tone === "running") {
    return <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  }
  if (tone === "waiting") {
    return <span className="size-3 shrink-0 rounded-full border-2 border-dotted border-current" aria-hidden="true" />;
  }
  return (
    <span aria-hidden="true" className="text-[10px] leading-none">
      {tone === "user" ? "●" : "■"}
    </span>
  );
}

function describeTrack(track: ReleaseTrack): string {
  const head = track.headline ? `：${track.headline.label}` : "";
  return `本番リリース ${track.done}/${track.total}${head}`;
}

/** 区切りだけの棒。**幅は固定**にして、横の文言の長さで行ごとに長さが変わらないようにする */
function Segments({ track, className }: { track: ReleaseTrack; className?: string }) {
  return (
    <span
      className={cn("grid shrink-0 gap-[3px]", className)}
      style={{ gridTemplateColumns: `repeat(${track.steps.length}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {track.steps.map((step) => (
        <span key={step.key} className={cn("h-1.5 rounded-sm", SEGMENT_CLASS[step.state])} title={`${step.label}: ${STATE_TEXT[step.state]}`} />
      ))}
    </span>
  );
}

/**
 * 畳んだ行・束の見出しに出す1行（バー＋いまの工程＋件数＋残りの工程）。
 * 工程ピル（`ReleaseStagePills`）と「mainへマージ待ち」のピルを置き換える
 */
export function ReleaseProgressTrackInline({ track }: { track: ReleaseTrack }) {
  const { headline } = track;
  return (
    <span
      role="img"
      aria-label={[describeTrack(track), ...track.others].join("、")}
      title={headline?.title ?? undefined}
      className="flex min-w-0 max-w-full items-center gap-2 text-xs"
      data-testid="release-progress-track"
    >
      <Segments track={track} className="w-28 sm:w-[150px]" />
      {headline && (
        <span className={cn("inline-flex min-w-0 items-center gap-1", TONE_CLASS[headline.tone])}>
          <ToneIcon tone={headline.tone} />
          <span className="truncate">{headline.label}</span>
        </span>
      )}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {track.done}/{track.total}
      </span>
      {track.others.length > 0 && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">＋{track.others.join("・")}</span>
      )}
    </span>
  );
}

/** 区切りごとに工程名を添えたバー。「次のリリース」カードで使う */
export type LabeledTrackStep = {
  key: string;
  label: string;
  state: ReleaseTrackStepState;
  /** 工程名の下に添える補足（時刻・状態の文言など） */
  sub?: string | null;
};

const LABEL_CLASS: Record<ReleaseTrackStepState, string> = {
  done: "text-foreground",
  running: "font-semibold text-purple-700 dark:text-purple-300",
  waiting: "text-purple-700/80 dark:text-purple-300/80",
  user: "font-semibold text-amber-700 dark:text-amber-400",
  failed: "font-semibold text-destructive",
  todo: "text-muted-foreground",
  skipped: "text-muted-foreground/60",
};

export function ReleaseProgressTrackLabeled({
  steps,
  ariaLabel,
  testId,
}: {
  steps: readonly LabeledTrackStep[];
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <ol
      className="grid min-w-0 gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {steps.map((step) => (
        <li
          key={step.key}
          className="flex min-w-0 flex-col gap-0.5"
          aria-label={`${step.label}: ${STATE_TEXT[step.state]}${step.sub ? `（${step.sub}）` : ""}`}
          aria-current={step.state === "running" || step.state === "user" || step.state === "failed" ? "step" : undefined}
        >
          <span className={cn("h-1.5 rounded-sm", SEGMENT_CLASS[step.state])} aria-hidden="true" />
          <span className={cn("truncate text-[10.5px] leading-tight", LABEL_CLASS[step.state])} aria-hidden="true">
            {step.state === "done" && "✓ "}
            {step.label}
          </span>
          {step.sub && (
            <span className="truncate text-[10px] leading-tight text-muted-foreground tabular-nums" aria-hidden="true">
              {step.sub}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
