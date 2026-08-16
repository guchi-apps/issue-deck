"use client";

import { History } from "lucide-react";

import packageJson from "../../../../package.json";
import { cn } from "@/lib/utils";

/**
 * 設定画面に常設するバージョン表示（#1764）。押すと「更新履歴」区分へ移動する。
 *
 * **区分の中ではなく外に置く。** 以前はアカウント区分の末尾にしか無く、いま動いている
 * バージョンを見るのに設定 → アカウントまで開く必要があった。PCは左タブの最下部、
 * スマホは区分一覧の最下部に置き、設定を開いていれば常に目に入るようにしている。
 */
export function AppVersionButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <History className="size-3.5 shrink-0" />
      <span>
        Issue Deck <span className="font-medium text-foreground tabular-nums">v{packageJson.version}</span>
      </span>
    </button>
  );
}
