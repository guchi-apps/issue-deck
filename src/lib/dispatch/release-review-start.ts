import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { requestReleaseReviewJob, type RequestReleaseReviewResult } from "@/lib/dispatch/release-review-jobs";
import { isCurrentReleaseReviewTarget } from "@/lib/dispatch/release-review-reevaluate";
import { decideReleaseReviewStart, readAwaitingIntegration } from "@/lib/release-review-start";
import type { ReleaseVerificationTarget } from "@/lib/release-verification";

/**
 * 全体レビューを、同じ対象の統合検証が終わってから開始する（#4763）。判定は純関数`decideReleaseReviewStart`が持ち、
 * ここは記録・ジョブを読んで「待つ印を付ける」か「積む」だけ。
 *
 * 自動で全体レビューを積む経路（候補作成・revision更新・正式バンプ後の再検証・`release-verify`の依頼）はすべてここを通る。
 * 待たせた対象は、統合検証の完了報告（`/api/dispatch/report`）かpollerの巡回が`startDeferredReleaseReview`で開始する。
 * 画面の手動再実行（#4632）は従来どおり`rerunReleaseReviewJob`を直接呼び、統合検証の待機中は受け付けない。
 */

export type RequestReleaseReviewAfterIntegrationResult =
  | RequestReleaseReviewResult
  /** 統合検証の完了まで待たせた（記録は`waiting`のまま、`findings.awaitingIntegration`を付けた） */
  | { ok: true; outcome: "deferred" };

async function loadStartInput(target: ReleaseVerificationTarget) {
  const [integration, lastVerifyJob] = await Promise.all([
    db.releaseVerification.findFirst({
      where: { ...target, kind: "integration" },
      select: { state: true, createdAt: true },
    }),
    db.dispatchJob.findFirst({
      where: {
        kind: "RELEASE_VERIFY",
        repositoryFullName: target.repoFullName,
        prNumber: target.prNumber,
        baseSha: target.baseSha,
        headSha: target.headSha,
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, targetHost: true, claimedAt: true },
    }),
  ]);
  return { integration, lastVerifyJob };
}

/** 記録の`findings`を、待機の印だけ差し替えて書く。結果の出た記録には触れない（状態`waiting`を条件にする） */
async function writeAwaitingMarker(target: ReleaseVerificationTarget, marker: { since: string } | null): Promise<void> {
  const row = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { state: true, findings: true },
  });
  if (!row || row.state !== "waiting") return;
  const current =
    typeof row.findings === "object" && row.findings !== null && !Array.isArray(row.findings)
      ? { ...(row.findings as Record<string, unknown>) }
      : {};
  if (marker) {
    if (readAwaitingIntegration(current)) return; // 最初に待たせ始めた時刻を残す
    current.awaitingIntegration = marker;
  } else {
    if (!("awaitingIntegration" in current)) return;
    delete current.awaitingIntegration;
  }
  await db.releaseVerification.updateMany({
    where: { ...target, kind: "ai_review", state: "waiting" },
    data: { findings: Object.keys(current).length > 0 ? (current as Prisma.InputJsonObject) : Prisma.DbNull },
  });
}

/**
 * 自動経路から全体レビューを依頼する。統合検証が動いている間は積まずに待たせ、終わっていれば（失敗・対象外・積めなかった
 * 場合を含む）統合検証を実行したホストを優先して積む
 */
export async function requestReleaseReviewAfterIntegration(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<RequestReleaseReviewAfterIntegrationResult> {
  const decision = decideReleaseReviewStart({ ...(await loadStartInput(target)), now });
  if (decision.action === "wait") {
    await writeAwaitingMarker(target, { since: now.toISOString() });
    return { ok: true, outcome: "deferred" };
  }
  const result = await requestReleaseReviewJob(target, now, { preferredHost: decision.preferredHost });
  if (result.ok) await writeAwaitingMarker(target, null);
  return result;
}

export type StartDeferredOutcome =
  | { action: "started"; outcome: "queued" | "already_queued" }
  | { action: "skipped"; reason: "not_deferred" | "not_current" | "still_waiting" | "no_host" };

/**
 * 待たせていた全体レビューを、統合検証が終わっていれば開始する。待たせていない対象（印の無い記録・結果の出た記録）には何もしない。
 * 積めるホストが無いときは従来どおり`ai_review`へ失敗を記録する（待ち続けると、永久に「完了待ち」に見えるため）
 */
export async function startDeferredReleaseReview(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<StartDeferredOutcome> {
  const review = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { state: true, findings: true },
  });
  if (!review || review.state !== "waiting" || !readAwaitingIntegration(review.findings)) {
    return { action: "skipped", reason: "not_deferred" };
  }
  // 古い対象（候補の更新・mainの前進で別のSHAへ移った）は開始しない。積むと同じPRの新しい対象の待機中ジョブを取り消してしまう
  if (!(await isCurrentReleaseReviewTarget(target))) return { action: "skipped", reason: "not_current" };
  const result = await requestReleaseReviewAfterIntegration(target, now);
  if (!result.ok) return { action: "skipped", reason: "no_host" };
  if (result.outcome === "deferred") return { action: "skipped", reason: "still_waiting" };
  return { action: "started", outcome: result.outcome };
}

/** 呼び出し元の失敗で報告そのものを落とさないための包み。失敗したときはnullを返す */
export async function startDeferredReleaseReviewSafely(
  target: ReleaseVerificationTarget,
  origin: string,
): Promise<StartDeferredOutcome | null> {
  try {
    const outcome = await startDeferredReleaseReview(target);
    if (outcome.action === "started") {
      console.info(
        `[release-review-start] ${origin}: ${target.repoFullName}#${target.prNumber}@${target.headSha.slice(0, 7)} → ${outcome.outcome}`,
      );
    }
    return outcome;
  } catch (error) {
    console.error(`[release-review-start] ${origin}: 全体レビューの開始判定に失敗しました`, error);
    return null;
  }
}

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** 1回の巡回で扱う「待たせている・currentな対象」の上限 */
const SWEEP_LIMIT = 50;
const SWEEP_PAGE_SIZE = 100;
/** 1回の巡回で読む待機中の記録の上限（印の無い記録を含む）。暴走しないための安全弁 */
const SWEEP_SCAN_MAX = 2_000;
let lastSweepAt = 0;

/**
 * 直近の待機中の全体レビューのうち、待機の印が付いた記録を新しい順に集める。印の無い記録（候補の更新で取り残された古いSHAの
 * 記録など）は上限に数えないよう、ページを読み進めて絞り込む（#4775）。開始すると記録の`updatedAt`が変わり並びがずれるため、
 * 開始する前に集め切る
 */
async function findAwaitingReviewTargets(now: Date): Promise<ReleaseVerificationTarget[]> {
  const targets: ReleaseVerificationTarget[] = [];
  for (let skip = 0; skip < SWEEP_SCAN_MAX; skip += SWEEP_PAGE_SIZE) {
    const rows = await db.releaseVerification.findMany({
      where: { kind: "ai_review", state: "waiting", updatedAt: { gte: new Date(now.getTime() - SWEEP_WINDOW_MS) } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip,
      take: SWEEP_PAGE_SIZE,
      select: { repoFullName: true, prNumber: true, baseSha: true, headSha: true, findings: true },
    });
    for (const row of rows) {
      if (!readAwaitingIntegration(row.findings)) continue;
      targets.push({ repoFullName: row.repoFullName, prNumber: row.prNumber, baseSha: row.baseSha, headSha: row.headSha });
    }
    if (rows.length < SWEEP_PAGE_SIZE) break;
  }
  return targets;
}

/**
 * 巡回での再照合（pollerの`claim`ごと。1分に1回まで）。統合検証の完了報告の反映に失敗した・issue-deckが再起動した・
 * 統合検証を積めずに猶予を過ぎた対象を拾って開始する。待機の印が付いた全体レビューの記録だけを見て、上限には
 * 印付きでcurrentな対象だけを数える（古い対象・既に開始された対象で上限が埋まり、待っている対象を拾えなくならないように。#4775）
 */
export async function sweepDeferredReleaseReviews(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now.getTime();
  let handled = 0;
  for (const target of await findAwaitingReviewTargets(now)) {
    if (handled >= SWEEP_LIMIT) break;
    const outcome = await startDeferredReleaseReviewSafely(target, "sweep");
    if (outcome?.action === "skipped" && (outcome.reason === "not_current" || outcome.reason === "not_deferred")) continue;
    handled += 1;
  }
}

/** テスト用: 巡回の間引きを戻す */
export function resetDeferredReleaseReviewSweepForTest(): void {
  lastSweepAt = 0;
}
