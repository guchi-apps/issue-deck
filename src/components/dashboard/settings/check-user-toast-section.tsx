"use client";

import { useCheckUserToastEnabled } from "@/hooks/use-check-user-toast-enabled";
import { cn } from "@/lib/utils";

/**
 * 確認待ちトーストの表示設定（#4262）。設定の「表示」区分に置く。
 * 保存ボタンは無く、切り替えた時点でこの端末に反映する。
 */
export function CheckUserToastSection() {
  const [enabled, setEnabled] = useCheckUserToastEnabled();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">確認待ちのトースト通知</p>
          <p className="text-xs text-muted-foreground">
            画面下部に「確認待ちになりました」を表示します。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="確認待ちのトースト通知"
          onClick={() => setEnabled(!enabled)}
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
            enabled ? "bg-primary" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-background transition-transform",
              enabled && "translate-x-4",
            )}
          />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        この設定はこの端末にだけ残ります。OSの通知や左メニューの件数には影響しません。
      </p>
    </div>
  );
}
