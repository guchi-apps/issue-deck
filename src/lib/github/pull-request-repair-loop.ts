import type { RepairKind } from "@/lib/github/pull-request-repair";
import type { CiState } from "@/lib/github/release-api";

/** 画面から開始した自動修復系列の最大修復回数。 */
export const AUTO_REPAIR_MAX_ROUNDS = 3;

export type AutoRepairLoopStatus = "running" | "completed" | "stopped";
export type AutoRepairStopReason =
  | "user_action_required"
  | "max_rounds_reached"
  | "repeated_problem"
  | "pull_request_closed";

export type AutoRepairLoopState = {
  status: AutoRepairLoopStatus;
  headSha: string;
  round: number;
  currentKind: RepairKind | null;
  lastFingerprint: string | null;
};

export type AutoRepairObservation = {
  state: "open" | "closed";
  draft?: boolean;
  /** このPRでレビュー完了を待つ必要があるか。CI/conflictのみの経路ではfalse。 */
  reviewRequired?: boolean;
  headSha: string;
  mergeable: boolean | null;
  ciState: CiState | null;
  /** 現在HEADに対する判定だけを渡す。未完了ならnull。 */
  review: "lgtm" | "changes-requested" | "needs-check" | null;
  repairRunning: boolean;
};

export type AutoRepairDecision =
  | { action: "wait" }
  | { action: "complete" }
  | { action: "stop"; reason: AutoRepairStopReason }
  | { action: "dispatch"; kind: RepairKind; fingerprint: string };

/**
 * 1巡分の状態遷移。IOを持たないことで、優先順位・鮮度・無限ループ防止を単体で検証する。
 * `review`には現在HEADと一致する判定しか渡さないため、古いchanges-requestedは修復対象にならない。
 */
export function decideAutoRepairLoop(
  loop: AutoRepairLoopState,
  observation: AutoRepairObservation,
): AutoRepairDecision {
  if (observation.state !== "open" || observation.draft) return { action: "stop", reason: "pull_request_closed" };
  if (observation.repairRunning) return { action: "wait" };

  // 修復後の新HEADでは、CIとレビューが両方そろうまで古い結果で次を起動しない。
  if (observation.ciState === "pending" || observation.ciState === "unknown" || observation.ciState === null) {
    return { action: "wait" };
  }
  if (observation.reviewRequired !== false && observation.review === null) return { action: "wait" };

  const kind: RepairKind | null =
    observation.mergeable === false
      ? "conflict"
      : observation.ciState === "failure"
        ? "ci"
        : observation.reviewRequired !== false && observation.review === "changes-requested"
          ? "review"
          : null;

  if (kind === null) {
    if (observation.reviewRequired !== false && observation.review === "needs-check") return { action: "stop", reason: "user_action_required" };
    return { action: "complete" };
  }
  if (loop.round >= AUTO_REPAIR_MAX_ROUNDS) return { action: "stop", reason: "max_rounds_reached" };

  const fingerprint = `${observation.headSha}:${kind}`;
  if (loop.lastFingerprint === fingerprint) return { action: "stop", reason: "repeated_problem" };
  return { action: "dispatch", kind, fingerprint };
}
