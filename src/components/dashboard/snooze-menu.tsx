"use client";

import { Clock } from "lucide-react";
import { Fragment, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildSnoozePresets,
  defaultSnoozeUntilDateValue,
  parseSnoozeUntilDate,
  type SnoozeTarget,
} from "@/lib/snooze";
import { cn } from "@/lib/utils";

/**
 * 「いまは実施しない」を選ぶメニュー（#2398）。
 *
 * **ダイアログを挟まない。** 伏せるのは取り消しの効く操作で、確認を挟むと「気になったら
 * その場で下げる」という使い方にならない。選んだ瞬間に一覧から消え、消えたことは一覧の
 * 1行（`SnoozedItemsBar`）が伝える。
 *
 * 選択肢の中身と戻る時刻の組み立ては`lib/snooze.ts`が持ち、ここは描くだけ。一覧の行・
 * Issue詳細・マージ待ちPRのカードがすべてこのコンポーネントを通るので、どこから開いても
 * 同じ選択肢になる。
 */
export function SnoozeMenu({
  target,
  onSnooze,
  now,
  align = "end",
  children,
  className,
}: {
  target: SnoozeTarget;
  onSnooze: (target: SnoozeTarget, until: string | null) => void;
  /** 現在時刻(epoch ms)。マウント前などで未取得(null)なら実時刻を使う */
  now: number | null;
  align?: "start" | "center" | "end";
  /** トリガー。省略すると時計アイコンのボタンになる */
  children?: React.ReactNode;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  /**
   * 開いた瞬間の時刻（epoch ms）。**描画中に`Date.now()`を読まない**ための取り方で、
   * 30秒ごとにしか進まない`now`（`useNow`）が未取得のあいだも選択肢を正しい日付で出せる。
   */
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [dateValue, setDateValue] = useState<string | null>(null);
  const baseNow = openedAt ?? now;
  const presets = baseNow === null ? [] : buildSnoozePresets(baseNow);
  const shownDate = dateValue ?? (baseNow === null ? "" : defaultSnoozeUntilDateValue(baseNow));
  const parsedDate = parseSnoozeUntilDate(shownDate);

  function choose(until: string | null) {
    setIsOpen(false);
    onSnooze(target, until);
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        // 開くたびに時刻を取り直す（開きっぱなしで日付をまたいでも、次に開けば揃う）
        if (open) setOpenedAt(Date.now());
        setIsOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        {children ?? (
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="保留にする"
            title="保留にする（いまは実施しない）"
            className={cn("pointer-events-auto shrink-0 text-muted-foreground", className)}
          >
            <Clock />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[17rem] p-0">
        <div className="px-3 pt-3 pb-1.5">
          <p className="text-xs font-semibold">いまは実施しない</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            一覧・件数・通知から外します。GitHubのラベルは変わりません。
          </p>
        </div>
        <div className="flex flex-col p-1">
          {presets.map((preset, index) => (
            <Fragment key={preset.id}>
              {preset.hint === null && index > 0 && <div className="my-1 h-px bg-border" />}
              <button
                type="button"
                onClick={() => choose(preset.until)}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <span>{preset.label}</span>
                {preset.hint && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {preset.hint}
                  </span>
                )}
              </button>
            </Fragment>
          ))}
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center gap-1.5 px-2 py-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">日時を指定</span>
          <Input
            type="date"
            value={shownDate}
            onChange={(event) => setDateValue(event.target.value)}
            aria-label="保留を解除する日付"
            className="h-7 min-w-0 flex-1 px-2 text-xs tabular-nums"
          />
          <Button
            size="xs"
            className="shrink-0"
            disabled={parsedDate === null}
            onClick={() => parsedDate && choose(parsedDate)}
          >
            設定
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
