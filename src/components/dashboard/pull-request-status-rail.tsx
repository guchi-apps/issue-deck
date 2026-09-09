"use client";

import { Check, CircleAlert, Hourglass, Loader2, type LucideIcon } from "lucide-react";

import {
  buildPullRequestStatusRail,
  type PullRequestRailSlot,
  type PullRequestRailSlotState,
} from "@/lib/pull-request-status-rail";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 枠の見た目。Issue詳細の内訳（`workflow-status-steps.tsx`の`PR_STEP_CLASS`）と同じ配色に
 * 揃えてある——同じ段を別の色で出すと、どちらが新しいのかを読む側が判断できなくなる。
 *
 * `absent`（その段自体が無い）だけは新しく足したもので、**破線の輪郭で場所だけ空ける。**
 * 空にすると列がずれ、実線の輪郭にすると「まだ来ていない」（`pending`）と見分けが付かない。
 */
const SLOT_CLASS: Record<PullRequestRailSlotState, string> = {
  done: "border-foreground/25 text-foreground",
  current: "border-primary bg-primary/10 text-primary font-semibold",
  waiting: "border-amber-500 bg-amber-500/10 font-semibold text-amber-700 dark:text-amber-400",
  failed: "border-destructive bg-destructive/10 text-destructive font-semibold",
  pending: "border-border text-muted-foreground",
  absent: "border-dashed border-border text-muted-foreground/60 justify-center",
};

const SLOT_ICON: Partial<Record<PullRequestRailSlotState, LucideIcon>> = {
  done: Check,
  current: Loader2,
  waiting: Hourglass,
  failed: CircleAlert,
};

function SlotIcon({ state }: { state: PullRequestRailSlotState }) {
  const Icon = SLOT_ICON[state];
  if (!Icon) return null;
  // 回すのは機械が動いているときだけ。人待ち（砂時計）を回すと「あと少しで終わる」に読める
  return (
    <Icon
      className={cn("size-3 shrink-0", state === "current" && "animate-spin")}
      aria-hidden="true"
    />
  );
}

function RailSlot({ slot, linkable }: { slot: PullRequestRailSlot; linkable: boolean }) {
  const className = cn(
    "inline-flex min-w-0 items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px] leading-5",
    SLOT_CLASS[slot.state],
  );
  const title = slot.title ? `${slot.columnLabel}: ${slot.title}` : slot.columnLabel;
  const content = (
    <>
      <SlotIcon state={slot.state} />
      <span className="truncate">{slot.label}</span>
    </>
  );

  if (slot.href === null || !linkable) {
    return (
      <span className={className} title={title}>
        {content}
      </span>
    );
  }
  return (
    <a
      href={slot.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, "hover:underline")}
      title={`${title}（クリックで実行ログを開きます）`}
    >
      {content}
    </a>
  );
}

/**
 * PR一覧の1行に出す、場所を固定した状態の列（#2942）。
 *
 * **CI → Claudeのレビュー → マージ**の3枠を等幅のグリッドに置き、行をまたいで同じ位置に
 * 並べる。以前は状態を表すバッジが「出るものだけ」横に並んでいたため、行ごとに数も並び順も
 * 変わり、縦に読み比べられなかった。判定と文言は
 * [`lib/pull-request-status-rail.ts`](../../lib/pull-request-status-rail.ts)が持つ。
 *
 * **幅は列ではなくグリッド全体の上限（`max-w`）で決め、枠は常に等分にする。** 枠ごとに
 * `minmax()`で下限を置くと3枠が別々に縮み、列の位置が行によってずれる。
 *
 * **狭いときは1行3枠をやめて2行に折る**（#2942）。**横幅がいちばん厳しいのはスマホではなく
 * PCのカラム**で（#2516。`docs/code-map.md`「一覧の行で横幅がいちばん厳しいのはPC・iPadで、
 * スマホではない」）、PR一覧ペインは最小320px（行の余白を引いて実効284px）、確認待ちの
 * マージ待ちカードはIssue一覧カラムの最小280pxの中に入るので実効230px前後しかない。
 * そこへ3枠を並べると1枠の文字が3〜4文字しか入らず、「レビュー完了」が「レビ…」になる。
 * 2行に折っても**同じ一覧の中では全行が同時に折れる**ので、列の位置は揃ったまま。
 *
 * 切り替えは**コンテナクエリ**で行う。ビューポート幅のブレークポイントは使えない——PCでも
 * PRペインだけが狭いことがあり、画面の広さでは枠の広さを決められない。`@container`は
 * このコンポーネント自身が持つので、**置く側は何も渡さなくてよい。**
 *
 * コンフリクトの自動修復（`RepairRunBadge`）はこの列に入れない。経過時間を数え直す生きた
 * バッジで、めったに出ないものを固定の枠に居座らせると3枠のどれかを常に空けることになる。
 */
export function PullRequestStatusRail({
  pullRequest,
  linkable = true,
  className,
}: {
  pullRequest: PullRequestSummary;
  /**
   * 実行ログへのリンクにしてよいか（既定は`true`）。**カード全体が`<button>`になっている
   * 場所（確認待ちのマージ待ちカード）では`false`を渡す**——`<button>`の中に`<a>`を置くのは
   * HTMLとして不正で、押したときの当たり判定も読み上げも壊れる。
   */
  linkable?: boolean;
  className?: string;
}) {
  const slots = buildPullRequestStatusRail(pullRequest);

  return (
    // `<button>`の中にも置けるよう`<span>`にする（`<div>`は`<button>`の中に置けない）
    <span className={cn("@container block w-full max-w-[23rem]", className)}>
      <span
        className="grid grid-cols-2 gap-1 @min-[20rem]:grid-cols-3"
        aria-label="CI・Claudeのレビュー・マージの状況"
      >
        {slots.map((slot) => (
          <RailSlot key={slot.key} slot={slot} linkable={linkable} />
        ))}
      </span>
    </span>
  );
}
