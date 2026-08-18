"use client";

import { RotateCw } from "lucide-react";

import type { PullToRefreshHandle } from "@/hooks/use-pull-to-refresh";
import { cn } from "@/lib/utils";

/**
 * 一覧を下へ引っ張ったときに上端へ出す表示（#1893・#1947）。
 *
 * **Issue一覧（`issue-list.tsx`）とPR一覧（`pull-request-list.tsx`）で共有する。**
 * 引っ張りの判定は`use-pull-to-refresh.ts`に集約してあるが、描画をそれぞれに書くと
 * 文言・色・戻りのアニメーションが片方だけ変わり、同じ操作なのに画面ごとに違う見え方に
 * なってしまう。
 *
 * **置く先は`position: relative`な枠の中。** この要素は枠の上端へ絶対配置し、引っ張った量を
 * 高さとして持つ（枠の中身は同じ量だけ下へずらす）。
 */
export function PullToRefreshIndicator({ pull }: { pull: PullToRefreshHandle }) {
  if (!pull.label) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center overflow-hidden"
      style={{
        height: pull.distance,
        // 指の動きにはそのまま追従させ、離した後の戻りだけアニメーションさせる
        transition: pull.isDragging ? "none" : "height 0.2s ease-out",
      }}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs whitespace-nowrap text-muted-foreground shadow-sm",
          // しきい値に届いた（離せば更新される）ことは、文言だけでなく色でも示す
          (pull.phase === "ready" || pull.phase === "refreshing") &&
            "border-primary/30 bg-accent text-foreground",
        )}
      >
        <RotateCw
          className={cn("size-3.5", pull.phase === "refreshing" && "animate-spin")}
          style={
            pull.phase === "refreshing"
              ? undefined
              : { transform: `rotate(${pull.arrowDegrees}deg)` }
          }
        />
        {pull.label}
      </span>
    </div>
  );
}
