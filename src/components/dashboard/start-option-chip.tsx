"use client";

import {
  Camera,
  Check,
  ClipboardList,
  GitMerge,
  MonitorPlay,
  Palette,
  type LucideIcon,
} from "lucide-react";

import type { StartImplementationOptionKey } from "@/lib/github/start-implementation";
import { cn } from "@/lib/utils";

/**
 * オプションのアイコン（#1623）。**定義側（`start-implementation.ts`）ではなくここに置く。**
 * あちらはAPIルートなどサーバ側からも読まれるため、Reactコンポーネントへ依存させない。
 */
export const START_OPTION_ICONS: Record<StartImplementationOptionKey, LucideIcon> = {
  planRequired: ClipboardList,
  artifactRequired: Palette,
  mergeConfirmRequired: GitMerge,
  previewRequired: MonitorPlay,
  screenshotRequired: Camera,
};

/**
 * オプション1件（#1623）。**アイコンとラベルを横に並べた行型のチップ。**
 *
 * 実行先（アイコン中心・中央揃え）とわざと形を変えている。同じ見た目のグリッドが上下に続くと、
 * 「どちらが実行先でどちらがオプションか」が一目で分からなくなるため。説明は`title`と
 * グリッド下のリストに出す。
 *
 * **「実装を開始」ダイアログと「まとめて実行」バーで共有する**（#1993）。どちらも同じ
 * `START_IMPLEMENTATION_OPTIONS`を並べるもので、片方だけ見た目が変わる理由が無い。
 */
export function StartOptionChip({
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={description}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-h-[46px] items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-left",
        checked ? "border-primary bg-accent" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Icon className={cn("size-4 shrink-0", checked ? "text-foreground" : "text-muted-foreground")} />
      <span className="text-[11px] font-medium leading-tight">{label}</span>
      {/* 押しても幅が動かないよう、OFFのときも場所だけ確保する */}
      <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !checked && "invisible")} />
    </button>
  );
}
