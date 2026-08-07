"use client";

import { useEffect, useState } from "react";

import type { WorkflowRunInfo } from "@/hooks/use-issue-workflow-run";
import { formatDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";

type WorkflowRunStatusProps = {
  run: WorkflowRunInfo | null;
};

const TICK_INTERVAL_MS = 1_000;

/** Issueコメント中の「実行ログ:」リンクが指すGitHub Actions実行の経過時間・所要時間を表示する */
export function WorkflowRunStatus({ run }: WorkflowRunStatusProps) {
  const isRunning = run !== null && run.status !== "completed";
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!isRunning) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 実行中の経過時間を1秒ごとに描画に反映するための初期同期
    setNow(Date.now());
    const intervalId = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [isRunning]);

  if (!run) return null;

  const elapsedMs = isRunning
    ? (now ?? Date.parse(run.updatedAt)) - new Date(run.startedAt).getTime()
    : new Date(run.updatedAt).getTime() - new Date(run.startedAt).getTime();
  const failed = !isRunning && run.conclusion !== null && run.conclusion !== "success";

  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center whitespace-nowrap text-[10px] font-medium",
        isRunning ? "text-primary" : failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {isRunning ? `実行中: ${formatDuration(elapsedMs)}経過` : `所要時間: ${formatDuration(elapsedMs)}`}
    </span>
  );
}
