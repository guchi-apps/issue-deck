/**
 * 全体レビュー（`ai_review`）を、同じ対象（PR・base・head）の統合検証が終わってから開始する判定（#4763）。
 *
 * 以前は統合検証と全体レビューを同時に積んでいた。統合検証の証跡は、それを実行したホストのローカルファイルで、
 * 実行中は未完了のため、1回目のレビューは確認項目を`unconfirmed`にして`needs_check`で終わり、統合検証の完了後に
 * 同じSHAで全体をもう1回実行していた（#4664の自動再評価）。**ここは「今積むか・待つか」と「どのホストを優先するか」だけを決め、**
 * 合否は変えない——統合検証の`failed`・`needs_check`もその結果をレビューに評価させるため、待たずに開始する。
 *
 * 永久に待たないよう、待つのは「同じ対象の統合検証ジョブが動いている（`QUEUED`・`CLAIMED`・`RUNNING`）」か、
 * 「統合検証の記録は待機中でジョブがまだ無く、依頼から猶予時間内」のときだけ。統合検証の記録が無い（引き継いだ・未依頼）・
 * 対象外・積めなかった・ジョブが報告なしで終わったときは、いずれも待たずに開始する。
 */

/** 依頼の直後でジョブがまだ見えない間だけ待つ猶予。過ぎたら統合検証は積めなかったとみなして開始する */
export const REVIEW_START_INTEGRATION_GRACE_MS = 10 * 60_000;

const FINISHED_INTEGRATION = ["passed", "failed", "needs_check"];
const ACTIVE_JOB = ["QUEUED", "CLAIMED", "RUNNING"];

export type ReviewStartReason =
  /** 統合検証が終わった（`passed`・`failed`・`needs_check`） */
  | "integration_finished"
  /** 統合検証の記録が無い（引き継いだ・依頼していない対象） */
  | "no_integration"
  /** 統合検証は対象外・未実施・無効など、待っても結果が出ない状態 */
  | "integration_not_pending"
  /** 記録は待機中のままだが、ジョブは報告なしで終わった（期限切れ・取り消し・報告の反映失敗） */
  | "integration_job_ended"
  /** 記録は待機中だがジョブが無く、猶予を過ぎた（積めなかった） */
  | "integration_not_queued";

export type ReviewStartDecision =
  | { action: "start"; reason: ReviewStartReason; preferredHost: string | null }
  | { action: "wait" };

export type ReviewStartInput = {
  /** 同じ対象の統合検証の記録。無ければnull */
  integration: { state: string; createdAt: Date } | null;
  /**
   * 同じ対象の最新の統合検証ジョブ。無ければnull。`claimedAt`はホストがジョブを取得した時刻で、
   * 入っているものだけを「統合検証を実際に動かした（その`targetHost`に証跡がある）」とみなす（#4775）
   */
  lastVerifyJob: { status: string; targetHost: string; claimedAt: Date | null } | null;
  now: Date;
};

/**
 * 全体レビューを今開始するか。開始するときは、統合検証を実行したホスト（証跡があるホスト）を優先先として返す。
 * 優先先が不適格なら、呼び出し側は従来の選び方（名前順の先頭）へフォールバックする
 */
export function decideReleaseReviewStart(input: ReviewStartInput): ReviewStartDecision {
  const { integration, lastVerifyJob, now } = input;
  // 状態では判定しない。`TIMEOUT`は`QUEUED`のまま期限切れになった（一度も動いていない）ジョブも含むため（#4775）
  const ranHost = lastVerifyJob?.claimedAt ? lastVerifyJob.targetHost : null;
  const start = (reason: ReviewStartReason): ReviewStartDecision => ({ action: "start", reason, preferredHost: ranHost });

  if (integration === null) return start("no_integration");
  if (FINISHED_INTEGRATION.includes(integration.state)) return start("integration_finished");
  if (integration.state !== "waiting" && integration.state !== "running") return start("integration_not_pending");

  if (lastVerifyJob !== null) {
    if (ACTIVE_JOB.includes(lastVerifyJob.status)) return { action: "wait" };
    return start("integration_job_ended");
  }
  if (now.getTime() - integration.createdAt.getTime() < REVIEW_START_INTEGRATION_GRACE_MS) return { action: "wait" };
  return start("integration_not_queued");
}

/** 記録の`findings.awaitingIntegration`。統合検証の完了まで開始を待たせている印 */
export type ReviewAwaitingIntegration = {
  /** 待たせ始めた時刻（ISO） */
  since: string;
};

export function readAwaitingIntegration(findings: unknown): ReviewAwaitingIntegration | null {
  const raw =
    typeof findings === "object" && findings !== null && !Array.isArray(findings)
      ? (findings as Record<string, unknown>).awaitingIntegration
      : null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const since = (raw as Record<string, unknown>).since;
  return typeof since === "string" ? { since } : null;
}
