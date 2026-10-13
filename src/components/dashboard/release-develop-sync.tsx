"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { DevelopSyncStatus } from "@/lib/release-develop-sync";
import { requestDevelopSync } from "@/lib/release-request";
import { cn } from "@/lib/utils";

/**
 * 公開内容のdevelopへの同期（#4641）。**本番公開の結果とは別の欄**として、同期状態・同期PR・止まっている理由・
 * 次の操作を出す。同期できていないことを本番公開の失敗とは表示しない。PCの個別ボタン・スマホのシート
 * （開始前の案内）と、本番PR詳細（公開後の候補）が同じ表示を使う。
 */

const CHIP = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold";

const TONE: Record<DevelopSyncStatus["state"], string> = {
  synced: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  unsynced: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unknown: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

export function ReleaseDevelopSyncNotice({
  repositoryFullName,
  sync,
  onChanged,
  showStartBlocked = false,
  className,
}: {
  repositoryFullName: string;
  sync: DevelopSyncStatus;
  /** 同期PRの作成・再確認のあとに、状況を取り直させる */
  onChanged: () => void;
  /** 開始前の案内として出すとき、次の候補を作れないことを明示する */
  showStartBlocked?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pr = sync.pullRequest;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestDevelopSync(repositoryFullName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <section
      aria-label="developへの同期"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5",
        sync.state === "unknown" ? "border-destructive/50" : sync.state === "unsynced" ? "border-amber-500/50" : "",
        className,
      )}
      data-testid="release-develop-sync"
      data-state={sync.state}
      data-detail={sync.detail}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-semibold">developへの同期</span>
        <span className={cn(CHIP, TONE[sync.state])}>{sync.label}</span>
        {showStartBlocked && sync.state !== "synced" && (
          <span className={cn(CHIP, "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>新規開始できません</span>
        )}
      </div>
      <p className="break-words text-xs">{sync.reason}</p>
      {sync.mainSha && (
        <p className="break-words font-mono text-[11.5px] text-muted-foreground">
          main {short(sync.mainSha)} · develop {short(sync.developSha)}
        </p>
      )}
      {sync.nextAction && <p className="break-words text-[11.5px] text-muted-foreground">次の操作: {sync.nextAction}</p>}
      {sync.state !== "synced" && <p className="text-[11.5px] text-muted-foreground">本番公開の結果とは別の状態です（公開の失敗ではありません）。</p>}
      <div className="flex flex-wrap gap-2">
        {pr && (
          <Button size="sm" className="h-7 px-2 text-xs" asChild>
            <a href={pr.url} target="_blank" rel="noreferrer">
              同期PR #{pr.number} を開く
            </a>
          </Button>
        )}
        {sync.canCreate && (
          <Button size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void create()}>
            {busy ? "作成中..." : "同期PRを作成"}
          </Button>
        )}
        {sync.state !== "synced" && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={onChanged}>
            再確認
          </Button>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
