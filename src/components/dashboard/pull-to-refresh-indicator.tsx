"use client";

import { RotateCw } from "lucide-react";

import type { PullToRefreshHandle } from "@/hooks/use-pull-to-refresh";
import { cn } from "@/lib/utils";

/**
 * 一覧を下へ引っ張ったときに上端へ出す表示（#1893でIssue一覧に入れ、#1958でブランチ画面と
 * 共通化した）。
 *
 * **置く側は`relative`な枠を用意し、その枠でタッチを受ける**（`usePullToRefresh`の
 * `containerRef`）。この部品は枠の上端に重ねて描くだけで、一覧を下げる動き（`translateY`）は
 * スクロール領域側が持つ——下げる対象は画面ごとに違う（Issue一覧は`<ul>`、ブランチ画面は
 * スクロールする`<div>`）ため。
 *
 * `idle`（引っ張っていない）ときは`label`がnullで、何も描かない。
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
