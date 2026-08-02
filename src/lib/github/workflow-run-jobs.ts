import type { GithubApiWorkflowJob } from "@/lib/github/actions-api";

/** 実行中のジョブのステップのうち、現在in_progressのものの名前を返す。該当なしなら null */
export function getCurrentStepName(jobs: GithubApiWorkflowJob[]): string | null {
  for (const job of jobs) {
    const step = job.steps.find((s) => s.status === "in_progress");
    if (step) return step.name;
  }
  return null;
}
