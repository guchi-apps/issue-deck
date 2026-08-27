"use client";

import { Clock } from "lucide-react";

import { SnoozeMenu } from "@/components/dashboard/snooze-menu";
import { Button } from "@/components/ui/button";
import { describeSnoozeUntil, type SnoozeEntry, type SnoozeTarget } from "@/lib/snooze";

/**
 * 保留中であることをIssue詳細のヘッダーの下に出す帯（#2398）。
 *
 * **一覧から消えた項目を開いたとき、なぜ数に入っていないのかが分かるのはここだけ。**
 * 一覧の行から開くこともあるが、通知・検索・本文中のリンクから直接開くこともあるため、
 * 期限と解除の導線を詳細側にも置く。
 *
 * 保留中でなければ何も描かない（`entry`がnull）。
 */
export function SnoozedItemNotice({
  entry,
  target,
  onSnooze,
  onUnsnooze,
  now,
}: {
  /** 効いている保留（`findActiveIssueSnooze`）。nullなら何も描かない */
  entry: SnoozeEntry | null;
  target: SnoozeTarget;
  onSnooze: (target: SnoozeTarget, until: string | null) => void;
  onUnsnooze: (target: SnoozeTarget) => void;
  /** 現在時刻(epoch ms)。未取得(null)なら実時刻を使う */
  now: number | null;
}) {
  if (!entry) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-slate-500/5 px-4 py-2 text-xs text-muted-foreground">
      <Clock className="size-3.5 shrink-0" />
      <p className="min-w-0 grow basis-48">
        <span className="font-medium text-foreground">
          {describeSnoozeUntil(entry.until, now)}
        </span>
        保留中です。件数と通知から外れています。
      </p>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {/* 期限の付け替えも保留の設定と同じメニュー（`SnoozeMenu`）を通す */}
        <SnoozeMenu target={target} onSnooze={onSnooze} now={now}>
          <Button size="xs" variant="outline">
            日時を変える
          </Button>
        </SnoozeMenu>
        <Button size="xs" variant="outline" onClick={() => onUnsnooze(target)}>
          保留を解除
        </Button>
      </span>
    </div>
  );
}
