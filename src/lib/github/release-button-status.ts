import type { ReleaseStatus } from "@/hooks/use-release-status";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

/**
 * ヘッダーの常時表示アイコン向けの4値サマリ。
 * "idle": 対象なし、または前回のデプロイが成功して静止している状態
 * "progressing": 自動で進行中（人の操作は不要）
 * "action_required": 人の操作（マージ等）が必要
 * "error": デプロイ失敗
 */
export type ReleaseButtonStatus = "idle" | "progressing" | "action_required" | "error";

/**
 * `AvailableReleaseStatus`からヘッダーのRocketボタン表示用の状態サマリを算出する（#542）。
 * `release-progress.tsx`の`buildSteps`とは意図的に判定ロジックを分離しているが、bump PRの
 * 「要操作」判定基準（CIが`pending`でなくなった時点）だけは揃えている。develop→main PRの
 * マージ待ちのみを主対象としつつ、CI通過後もbump PRが残り続けるauto-merge滞留も
 * 「要操作」に含める（#542でのフィードバックを反映）。
 */
export function summarizeReleaseButtonStatus(status: AvailableReleaseStatus): ReleaseButtonStatus {
  const { phase, bumpPullRequest: bump, deployWorkflowRun, workflowRun } = status;

  if (deployWorkflowRun && deployWorkflowRun.status === "completed" && deployWorkflowRun.conclusion !== "success") {
    return "error";
  }

  if (phase === "release_pr_open") {
    return "action_required";
  }

  if (phase === "bump_pr_open" && bump && bump.ciState !== "pending") {
    return "action_required";
  }

  if (workflowRun && workflowRun.status !== "completed") return "progressing";
  if (deployWorkflowRun && deployWorkflowRun.status !== "completed") return "progressing";
  if (phase === "bump_pr_open") return "progressing";
  if (phase === "release_pending") return "progressing";

  return "idle";
}
