"use client";

import { ChevronDown, Loader2, Play, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { cn } from "@/lib/utils";

type StartSplitTriggerProps = {
  /** 左のボタンの文言（既定の実行先を名乗る。#1262） */
  label: string;
  /** 起動先として選べるホスト名（表示順）。2台未満なら▼は出さない */
  hostNames: readonly string[];
  /** 左のボタン＝既定の実行先で「実装を開始」ダイアログを開く */
  onStartDefault: () => void;
  /** ▼から実行先を選んだとき。その実行先を選択済みでダイアログを開く */
  onStartOnHost: (hostName: string) => void;
  /** 縦積み（スマホ）向けに幅いっぱいにする */
  fullWidth?: boolean;
  isSubmitting?: boolean;
};

/**
 * 「実装を開始」の分割ボタン（#5569）。左は既定の実行先（サブPC）で開始、右端の▼で実行先を選ぶ。
 * どちらもダイアログを開くだけで、積む操作そのものはダイアログが持つ。
 */
export function StartSplitTrigger({
  label,
  hostNames,
  onStartDefault,
  onStartOnHost,
  fullWidth,
  isSubmitting = false,
}: StartSplitTriggerProps) {
  const hasMenu = hostNames.length >= 2;
  const size = fullWidth ? "default" : "sm";
  return (
    <div className={cn("inline-flex", fullWidth && "flex w-full")}>
      <Button
        size={size}
        className={cn(hasMenu && "rounded-r-none", fullWidth && "flex-1")}
        disabled={isSubmitting}
        onClick={onStartDefault}
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
        {label}
      </Button>
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size={size}
              className="rounded-l-none border-l border-primary-foreground/30 px-2"
              disabled={isSubmitting}
              aria-label="実行先を選んで開始"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              実行先を選ぶ
            </DropdownMenuLabel>
            {hostNames.map((name, index) => (
              <DropdownMenuItem key={name} onSelect={() => onStartOnHost(name)}>
                <Server className="size-3.5" />
                {formatDispatchHostName(name)}
                {index === 0 && <span className="text-xs text-muted-foreground">（既定）</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
