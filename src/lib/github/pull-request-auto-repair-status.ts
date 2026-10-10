import { db } from "@/lib/db";

/**
 * PRの自動修復系列（`PullRequestAutoRepairLoop`。#3978）のうち、画面が読む分（#4015）。
 *
 * `repairRun`（いま走っている1回の修復）とは別の軸で、**修復と修復の合間（pushした後の
 * 再検証待ち）と、止まった理由**を出すために持つ。GitHub APIは使わず、全リポジトリぶんを
 * まとめてDBへ1クエリ引くだけ。
 */
export type PullRequestAutoRepairSummary = {
  /** `dispatching`・`running`（系列が続いている）か、`stopped`（止まった）。`completed`は載せない */
  status: "dispatching" | "running" | "stopped";
  round: number;
  maxRounds: number;
  /** 止まった理由。`stopped`以外はnull */
  stopReason: string | null;
};

const STOP_REASON_LABEL: Record<string, string> = {
  user_action_required: "人の判断が必要です",
  max_rounds_reached: "修復の上限回数に達しました",
  repeated_problem: "修正後も同じ問題が残っています（修正コミットなし）",
  pull_request_closed: "PRが閉じられました",
  dispatch_failed: "修復の起動に失敗しました",
  timed_out: "待機がタイムアウトしました",
  stopped_by_user: "人が停止しました",
};

/** 停止理由の日本語。未知の値は値そのものを出す（理由を隠さない） */
export function autoRepairStopReasonLabel(reason: string | null): string {
  if (reason === null) return "理由は記録されていません";
  return STOP_REASON_LABEL[reason] ?? reason;
}

export function autoRepairLoopKey(repositoryFullName: string, pullRequestNumber: number): string {
  return `${repositoryFullName}#${pullRequestNumber}`;
}

/** 系列の状態を画面向けへ。画面に出さない`completed`と未知の状態はnull */
export function toAutoRepairSummary(row: {
  status: string;
  round: number;
  maxRounds: number;
  stopReason: string | null;
}): PullRequestAutoRepairSummary | null {
  if (row.status !== "dispatching" && row.status !== "running" && row.status !== "stopped") {
    return null;
  }
  return {
    status: row.status,
    round: row.round,
    maxRounds: row.maxRounds,
    stopReason: row.status === "stopped" ? row.stopReason : null,
  };
}

export async function fetchPullRequestAutoRepairSummaries(
  targets: { repositoryFullName: string; pullRequestNumber: number }[],
): Promise<Map<string, PullRequestAutoRepairSummary>> {
  const summaries = new Map<string, PullRequestAutoRepairSummary>();
  if (targets.length === 0) return summaries;

  const rows = await db.pullRequestAutoRepairLoop
    .findMany({
      where: {
        status: { in: ["dispatching", "running", "stopped"] },
        OR: targets.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          pullRequestNumber: target.pullRequestNumber,
        })),
      },
    })
    .catch((error: unknown) => {
      // 自動修正の状況が出ないだけで一覧は返す（`fetchActivePullRequestRepairRuns`と同じ扱い）
      console.warn("[fetchPullRequestAutoRepairSummaries] 取得に失敗しました:", error);
      return [];
    });

  for (const row of rows) {
    const summary = toAutoRepairSummary(row);
    if (summary) {
      summaries.set(autoRepairLoopKey(row.repositoryFullName, row.pullRequestNumber), summary);
    }
  }
  return summaries;
}
