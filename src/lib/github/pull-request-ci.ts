import type { GithubApiCheckRun } from "@/lib/github/actions-api";

export type PullRequestCiStatus = "in_progress" | "success" | "failure" | "none";

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** PRの最新コミットのチェック一覧から、CI状態を一つに集約する */
export function summarizePullRequestCiStatus(checkRuns: GithubApiCheckRun[]): PullRequestCiStatus {
  if (checkRuns.length === 0) return "none";
  if (checkRuns.some((run) => run.status !== "completed")) return "in_progress";
  const allSucceeded = checkRuns.every(
    (run) => run.conclusion !== null && SUCCESS_CONCLUSIONS.has(run.conclusion),
  );
  return allSucceeded ? "success" : "failure";
}
