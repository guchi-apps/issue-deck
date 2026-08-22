"use client";

import { RotateCw } from "lucide-react";

import type { PullToRefreshHandle } from "@/hooks/use-pull-to-refresh";
import { cn } from "@/lib/utils";

/**
 * 一覧を下へ引っ張ったときに上端へ出す表示（#1893でIssue一覧に入れ、#1947でPR一覧、
 * #1958でブランチ画面と共通化し、#2182でスマホのホーム画面にも置いた）。
 *
 * **Issue一覧（`issue-list.tsx`）・PR一覧（`pull-request-list.tsx`）・ブランチ画面
 * （`branch-flow-view.tsx`）・スマホのホーム（`mobile/mobile-home-screen.tsx`）で共有する。**
 * 引っ張りの判定は`use-pull-to-refresh.ts`に集約してあるが、描画をそれぞれに書くと文言・色・
 * 戻りのアニメーションが片方だけ変わり、同じ操作なのに画面ごとに違う見え方になってしまう。
 *
 * **置く側は`position: relative`な枠を用意し、その枠でタッチを受ける**（`usePullToRefresh`の
 * `containerRef`）。この部品は枠の上端へ絶対配置し、引っ張った量を高さとして持つだけで、
 * 一覧を下げる動き（枠の中身をずらす`translateY`）はスクロール領域側が持つ——下げる対象は
 * 画面ごとに違う（Issue一覧は`<ul>`、ブランチ画面はスクロールする`<div>`）ため。
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
