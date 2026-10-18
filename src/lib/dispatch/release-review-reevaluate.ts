import { db } from "@/lib/db";
import { rerunReleaseReviewJob } from "@/lib/dispatch/release-review-jobs";
import {
  decideReviewReevaluation,
  readAutoReevaluation,
  reviewDependsOnEvidence,
  type ReviewReevaluationDecision,
} from "@/lib/release-review-reevaluation";
import type { ReleaseVerificationTarget } from "@/lib/release-verification";

/**
 * 統合検証の完了後に、全体レビューの証跡待ち項目を自動で再評価する（#4664）。判定は純関数
 * `decideReviewReevaluation`が持ち、ここは記録・ジョブ・現候補を読んで積むだけ。
 *
 * 呼ぶのは3か所で、どれが先に来ても同じ結論になる（重複は`activeKey`と記録の印が止める）。
 * - 統合検証の完了報告（レビューが先に終わっていた場合）
 * - 全体レビューの完了報告（統合検証が先に終わっていた場合。レビューは開始時の古い証跡を読んでいる）
 * - pollerの巡回（報告の反映に失敗した・issue-deckが再起動した場合の再照合）
 *
 * **再評価はレビュー結果を記録し直すだけ。** 修正Issue・PR・候補・版は作らず、本番公開もしない。
 */

export type ReevaluateOutcome =
  | ReviewReevaluationDecision
  | { action: "skipped"; reason: "not_current" | "no_host" | "no_record" | "no_verify_host" };

/**
 * 対象が今も現在の候補か。**GitHub APIは呼ばずDBだけで決める**（報告の経路は利用者の権限を持たない）。
 * 統合検証の完了後の開始（#4763・`release-review-start.ts`）も同じ判定を使う。
 * - 同じPRに、より新しく依頼された別のSHAの記録があれば古い対象（候補の更新・mainの前進・バンプ後へ移った）
 * - 新方式の候補（`ReleaseCandidate`）に属するなら、候補が進行中（取消・完了していない）であること
 */
export async function isCurrentReleaseReviewTarget(target: ReleaseVerificationTarget): Promise<boolean> {
  const own = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { createdAt: true },
  });
  if (!own) return false;
  const newer = await db.releaseVerification.findFirst({
    where: {
      repoFullName: target.repoFullName,
      prNumber: target.prNumber,
      kind: "ai_review",
      createdAt: { gt: own.createdAt },
      OR: [{ baseSha: { not: target.baseSha } }, { headSha: { not: target.headSha } }],
    },
    select: { id: true },
  });
  if (newer) return false;
  const revision = await db.releaseCandidateRevision.findFirst({
    where: { prNumber: target.prNumber, candidate: { repositoryFullName: target.repoFullName } },
    orderBy: { createdAt: "desc" },
    select: { candidate: { select: { activeKey: true } } },
  });
  // 旧方式（候補の記録を持たないリリースPR）は、上の「より新しい対象が無い」だけで判断する
  return revision === null || revision.candidate.activeKey !== null;
}

export async function reevaluateReleaseReviewIfReady(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<ReevaluateOutcome> {
  const [review, integration, lastReviewJob] = await Promise.all([
    db.releaseVerification.findFirst({ where: { ...target, kind: "ai_review" } }),
    db.releaseVerification.findFirst({ where: { ...target, kind: "integration" } }),
    db.dispatchJob.findFirst({
      where: {
        kind: "RELEASE_REVIEW",
        repositoryFullName: target.repoFullName,
        prNumber: target.prNumber,
        baseSha: target.baseSha,
        headSha: target.headSha,
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true, claimedAt: true, startedAt: true, finishedAt: true },
    }),
  ]);
  if (!review) return { action: "skipped", reason: "no_record" };

  const findings = review.findings as Record<string, unknown> | null;
  const detailReview =
    findings && typeof findings.review === "object" && findings.review !== null
      ? (findings.review as { checks?: { status: string }[] })
      : null;
  const decision = decideReviewReevaluation({
    review: {
      state: review.state,
      hasDiagnostic: !!findings && typeof findings.diagnostic === "object" && findings.diagnostic !== null,
      dependsOnEvidence: reviewDependsOnEvidence({
        checks: detailReview?.checks ?? null,
        unverifiedScope: review.unverifiedScope,
      }),
      marker: readAutoReevaluation(review.findings),
      updatedAt: review.updatedAt,
    },
    integration: integration ? { state: integration.state, updatedAt: integration.updatedAt } : null,
    lastReviewJob,
  });

  if (decision.action === "fail_stalled") {
    // 状態を条件にして書く。巡回と報告が重なっても、先に届いた結果を上書きしない
    await db.releaseVerification.updateMany({
      where: { ...target, kind: "ai_review", state: review.state },
      data: { state: "failed", message: decision.message },
    });
    return decision;
  }
  if (decision.action !== "rerun") return decision;
  if (!(await isCurrentReleaseReviewTarget(target))) return { action: "skipped", reason: "not_current" };

  // 証跡は統合検証を実行したホストのローカルファイル。そのホストにだけ積む
  const verifyJob = await db.dispatchJob.findFirst({
    where: {
      kind: "RELEASE_VERIFY",
      repositoryFullName: target.repoFullName,
      prNumber: target.prNumber,
      baseSha: target.baseSha,
      headSha: target.headSha,
      status: { in: ["SUCCEEDED", "FAILED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { targetHost: true },
  });
  if (!verifyJob) return { action: "skipped", reason: "no_verify_host" };

  const result = await rerunReleaseReviewJob(target, now, {
    requiredHost: verifyJob.targetHost,
    recordNoHost: false,
    autoReevaluation: { integrationAt: decision.integrationAt, requestedAt: now.toISOString() },
  });
  if (!result.ok) return { action: "skipped", reason: "no_host" };
  return decision;
}

/** 呼び出し元の失敗で報告そのものを落とさないための包み。結果はログだけに残す */
export async function reevaluateReleaseReviewSafely(target: ReleaseVerificationTarget, origin: string): Promise<void> {
  try {
    const outcome = await reevaluateReleaseReviewIfReady(target);
    if (outcome.action === "rerun" || outcome.action === "fail_stalled") {
      console.info(
        `[release-review-reevaluate] ${origin}: ${target.repoFullName}#${target.prNumber}@${target.headSha.slice(0, 7)} → ${outcome.action}`,
      );
    }
  } catch (error) {
    console.error(`[release-review-reevaluate] ${origin}: 自動再評価の判定に失敗しました`, error);
  }
}

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_WINDOW_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 20;
let lastSweepAt = 0;

/**
 * 巡回での再照合（pollerの`claim`ごと。1分に1回まで）。報告の反映に失敗した・issue-deckが再起動して
 * 判定が抜けた対象を拾う。直近（24時間）に更新された全体レビューの記録だけを見て、件数にも上限を置く
 */
export async function sweepReleaseReviewReevaluation(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now.getTime();
  const rows = await db.releaseVerification.findMany({
    where: {
      kind: "ai_review",
      state: { in: ["passed", "needs_check", "failed", "waiting"] },
      updatedAt: { gte: new Date(now.getTime() - SWEEP_WINDOW_MS) },
    },
    orderBy: { updatedAt: "desc" },
    take: SWEEP_LIMIT,
    select: { repoFullName: true, prNumber: true, baseSha: true, headSha: true },
  });
  for (const row of rows) {
    await reevaluateReleaseReviewSafely(
      { repoFullName: row.repoFullName, prNumber: row.prNumber, baseSha: row.baseSha, headSha: row.headSha },
      "sweep",
    );
  }
}

/** テスト用: 巡回の間引きを戻す */
export function resetReleaseReviewReevaluationSweepForTest(): void {
  lastSweepAt = 0;
}
