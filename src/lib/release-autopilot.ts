/**
 * 「本番公開を開始」した候補の全自動の判断。**純関数だけ**を置き、DB・GitHubへの操作は`release-autopilot-run.ts`が持つ。
 *
 * 開始の操作が公開承認を兼ねる（全体レビューの担当は問わない）。ここが決めるのは、人が押していた
 * 「指摘の一括確定」「おまかせで公開承認まで進める」「本番公開へ進む（公開承認）」を代わりに行うかだけで、
 * 修正の反復は完了系列（`release-completion`）、承認後の公開は公開承認の系列が従来どおり持つ。
 * **進められないときは止めて、以後この候補を自動では進めない。** 全体レビューの未合格は承知扱いにしない。
 */
import { decideAutoProceedMode } from "@/lib/release-auto-proceed-mode";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/** 開始から自動で進めてよい期間。過ぎたら、開始時の指示を今の公開の承認とみなさない */
export const AUTOPILOT_TTL_MS = 24 * 60 * 60 * 1000;

export const AUTOPILOT_BLOCKING_LABELS = ["22.merge-confirm-required", "00.check-user"] as const;

export type AutopilotStopReason =
  | "expired"
  | "run_stopped"
  | "approval_ended"
  | "human_check_label"
  | "integration_environment"
  | "review_unverified"
  | "recommendations_unavailable"
  | "approval_failed"
  | "main_advanced"
  | "stopped_by_user";

export const AUTOPILOT_STOP_LABEL: Record<AutopilotStopReason, string> = {
  expired: "開始から24時間以内に公開できませんでした",
  run_stopped: "自動修正・自動公開の系列が止まりました",
  approval_ended: "公開承認が取り消されたか失効しました",
  human_check_label: "人の確認ラベルが付いています",
  integration_environment: "統合検証が実行ホストの環境不足で失敗しました",
  review_unverified: "全体レビューに、自動では解消できない未確認の範囲が残っています",
  recommendations_unavailable: "指摘の一部にAIの推奨を作れませんでした",
  approval_failed: "公開承認を出せませんでした",
  main_advanced: "mainが先に進んだか、候補が変わりました",
  stopped_by_user: "利用者が停止しました",
};

export type AutopilotInput = {
  now: Date;
  /** 自動公開を最後に開始・再開した時刻 */
  startedAt: Date;
  phase: string;
  /** 修正の取り込みなど、未完了の更新要求がある */
  hasPendingRevision: boolean;
  /** このリポジトリで進行中の完了系列がある（この候補以外のものも含む） */
  runActive: boolean;
  /** この候補の最新の完了系列の状態。無ければnull */
  candidateRunStatus: string | null;
  /** この候補の最新の公開承認の状態。無ければnull */
  approvalStatus: string | null;
  contract: { requiresAiReviewWaiver: boolean } | null;
  /** 候補PRの現在のbase/headの検証。読めなければnull */
  verification: ReleaseVerificationSummary | null;
  labels: readonly string[];
};

export type AutopilotDecision =
  | { action: "wait" }
  | { action: "approve" }
  | { action: "decide_findings" }
  | { action: "start_fix" }
  /** `notify=false`は、止めた側（系列・利用者の操作）が既に知らせている */
  | { action: "stop"; reason: AutopilotStopReason; notify: boolean };

const SETTLED_INTEGRATION = new Set(["passed", "failed", "needs_check", "not_applicable"]);

export function decideAutopilot(input: AutopilotInput): AutopilotDecision {
  if (input.candidateRunStatus === "stopped" || input.candidateRunStatus === "needs_attention") {
    return { action: "stop", reason: "run_stopped", notify: false };
  }
  // 公開準備に入った後は、公開承認の系列が最後まで持つ（系列が止まったことだけを上で拾う）
  if (input.phase !== "review") return { action: "wait" };
  if (input.approvalStatus === "revoked" || input.approvalStatus === "invalidated") {
    return { action: "stop", reason: "approval_ended", notify: true };
  }
  if (input.approvalStatus !== null) return { action: "wait" };
  if (input.now.getTime() - input.startedAt.getTime() >= AUTOPILOT_TTL_MS) return { action: "stop", reason: "expired", notify: true };
  if (input.hasPendingRevision) return { action: "wait" };

  if (input.contract !== null && !input.contract.requiresAiReviewWaiver) {
    if (input.labels.some((label) => (AUTOPILOT_BLOCKING_LABELS as readonly string[]).includes(label))) {
      return { action: "stop", reason: "human_check_label", notify: true };
    }
    return { action: "approve" };
  }
  // 系列が動いている間の修正・再検証は系列に任せる
  if (input.runActive) return { action: "wait" };

  const verification = input.verification;
  if (verification === null || !SETTLED_INTEGRATION.has(verification.integration.state)) return { action: "wait" };
  const mode = decideAutoProceedMode(verification, false);
  if (mode === "table") return { action: "decide_findings" };
  if (mode === "start") return { action: "start_fix" };
  if (mode === "environment") return { action: "stop", reason: "integration_environment", notify: true };
  if (mode === "unresolvable") return { action: "stop", reason: "review_unverified", notify: true };
  // 全体レビューの実行障害・統合検証の要確認は、系列が再実行か停止を判断する
  if (verification.aiReview.state === "failed" || verification.integration.state === "needs_check") return { action: "start_fix" };
  return { action: "wait" };
}

/** 公開承認の要求キー。再開のたびに別の値にして、前回の公開準備の結果が返らないようにする（8〜48文字の英数・`-`・`_`） */
export function buildAutopilotRequestKey(candidateId: string, headSha: string, startedAt: Date): string {
  const id = candidateId.replace(/[^A-Za-z0-9]/g, "").slice(-16);
  return `auto-${id}-${headSha.slice(0, 12)}-${startedAt.getTime().toString(36)}`;
}
