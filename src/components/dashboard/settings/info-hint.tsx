"use client";

import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * 設定項目の補足説明を、ラベル横の情報アイコンへ畳む（#4108）。
 *
 * 常時表示の段落が並ぶと設定値を探しにくいため、長い説明はここへ移す。現在値・警告・
 * 「次回から反映」のような操作判断に要る短い補足は畳まずに表示したままにすること。
 * クリック・タップ・Enter/Spaceで開き、Escか外側のクリックで閉じる（Radix Popover）。
 */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}の説明`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] text-xs leading-relaxed"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
