import type { IosStageState, IosStageStatus } from "@/lib/ios-testflight-status";
import { cn } from "@/lib/utils";

const SEGMENT_CLASS: Record<IosStageState, string> = {
  success: "bg-blue-600 dark:bg-blue-500",
  running: "animate-pulse bg-blue-600/60 dark:bg-blue-500/60",
  failure: "bg-destructive",
  // 点線で「飛ばした」ことを形で出す（未着手の無地と区別する）
  skipped:
    "bg-[repeating-linear-gradient(90deg,var(--color-border)_0_3px,transparent_3px_6px)]",
  pending: "bg-muted",
  unknown: "bg-muted",
};

const STATE_TEXT: Record<IosStageState, string> = {
  success: "成功",
  running: "実行中",
  failure: "失敗",
  skipped: "スキップ",
  pending: "待ち",
  unknown: "未実行",
};

/**
 * iOS配布の段階を区切り付きの1本のバーで出す（#4907）。リポジトリ先頭のブロック用で、どこで止まったか・
 * どこまで進んだかを開かずに読めるようにする。色は内訳（`ios-run-progress-panel.tsx`）と同じく、成功は
 * 緑でなく青（Webのデプロイ成功と取り違えないため）。幅が狭いと段階名を省き、失敗・実行中の名前だけを出す。
 */
export function IosDistributionStageBar({
  stages,
  notDistributed = false,
  thin = false,
}: {
  stages: readonly IosStageStatus[];
  /** 配布しなかった版。全段階を同じ灰色の無地にし、段階名も出さない */
  notDistributed?: boolean;
  /** バーを細く（4px）出す。ブランチ画面の要約カードを詰めるため（#4929） */
  thin?: boolean;
}) {
  const barHeight = thin ? "h-1" : "h-1.5";
  return (
    <ol
      className="@container grid gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      aria-label={notDistributed ? "iOS配布の段階（配布なし）" : "iOS配布の段階"}
    >
      {stages.map((stage) => {
        if (notDistributed) {
          return (
            <li key={stage.key} className="min-w-0" aria-label={`${stage.label}: 配布なし`}>
              <span className={cn("block rounded-sm bg-muted-foreground/25", barHeight)} aria-hidden="true" />
            </li>
          );
        }
        const emphasized = stage.state === "failure" || stage.state === "running";
        return (
          <li key={stage.key} className="flex min-w-0 flex-col gap-0.5" aria-label={`${stage.label}: ${STATE_TEXT[stage.state]}`}>
            <span className={cn("rounded-sm", barHeight, SEGMENT_CLASS[stage.state])} aria-hidden="true" />
            <span
              className={cn(
                "truncate text-[10px] leading-tight text-muted-foreground",
                !emphasized && "hidden @md:block",
                stage.state === "failure" && "overflow-visible font-semibold text-destructive",
                stage.state === "running" && "overflow-visible font-semibold text-blue-700 dark:text-blue-400",
              )}
              aria-hidden="true"
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
