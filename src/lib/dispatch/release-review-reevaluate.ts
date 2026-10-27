import { db } from "@/lib/db";
import { isDispatchHostOnline, parseDispatchHostRepositories } from "@/lib/dispatch/dispatch-job";
import { rerunReleaseReviewJob } from "@/lib/dispatch/release-review-jobs";
import {
  POLLER_REPOSITORY,
  assessReleaseOps,
  findOpsRequest,
  opsRequestTexts,
  type ReleaseOpsContext,
} from "@/lib/release-review-ops-evidence";
import {
  decideOpsReevaluation,
  decideReviewReevaluation,
  hostFactKey,
  readAutoReevaluation,
  readHostFacts,
  readOpsReevaluation,
  reviewDependsOnEvidence,
  reviewDependsOnHost,
  type OpsReevaluationDecision,
  type ReviewHostFacts,
  type ReviewOpsReevaluation,
  type ReviewReevaluationDecision,
} from "@/lib/release-review-reevaluation";
import type { ReleaseVerificationTarget } from "@/lib/release-verification";
import { loadReleaseOpsContext } from "@/lib/release-verification-load";

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
      opsMarker: readOpsReevaluation(review.findings),
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

/**
 * pollerの稼働事実の変化を契機にした自動再評価（#5111）。統合検証の完了を契機にする上の経路とは別に、
 * 全体レビューが「pollerの更新・再起動の未確認」（運用待ち）で要確認になった候補を対象にする。判定は純関数
 * `decideOpsReevaluation`が持ち、ここは記録・ホスト・ジョブ・稼働情報を読んで積むだけ。再評価そのものは
 * ランナーの#4799（ホストの指紋が変わった運用依存の結果だけ捨てる）が行い、確認済みの結果・指摘・判断は引き継がれる。
 *
 * **更新の事実だけで合格・公開・修正Issueの作成はしない**（結果はレビューが出し直す）。
 */

type OpsReviewRecord = { state: string; findings: unknown; unverifiedScope: string | null };

type OpsReviewFacts = {
  state: string;
  hasDiagnostic: boolean;
  waitsForOps: boolean;
  dependsOnEvidence: boolean;
  hostFacts: ReviewHostFacts | null;
  opsMarker: ReviewOpsReevaluation | null;
  opsTexts: (string | null)[];
};

function readOpsReviewFacts(row: OpsReviewRecord): OpsReviewFacts {
  const findings = row.findings as Record<string, unknown> | null;
  const detailReview =
    findings && typeof findings.review === "object" && findings.review !== null
      ? (findings.review as { checks?: { status: string; evidence: string | null }[] })
      : null;
  const checks = Array.isArray(detailReview?.checks) ? detailReview.checks : null;
  const opsTexts = opsRequestTexts({
    reason: null,
    unverifiedScope: row.unverifiedScope,
    review: checks ? { checks } : null,
  });
  return {
    state: row.state,
    hasDiagnostic: !!findings && typeof findings.diagnostic === "object" && findings.diagnostic !== null,
    // ランナーがホストの事実で見直す未確認（`reviewDependsOnHost`）で、かつ更新・再起動を要求している（言及だけは数えない）
    waitsForOps:
      reviewDependsOnHost({ checks, unverifiedScope: row.unverifiedScope }) && findOpsRequest(opsTexts) !== null,
    dependsOnEvidence: reviewDependsOnEvidence({ checks, unverifiedScope: row.unverifiedScope }),
    hostFacts: readHostFacts(row.findings),
    opsMarker: readOpsReevaluation(row.findings),
    opsTexts,
  };
}

/** 記録・ジョブ・稼働情報から判定する。画面（自動で開始しない理由の表示）と巡回が同じ判定を使う */
async function decideOpsReevaluationFor(
  target: ReleaseVerificationTarget,
  facts: OpsReviewFacts,
  context: ReleaseOpsContext | null,
): Promise<OpsReevaluationDecision> {
  const jobWhere = {
    repositoryFullName: target.repoFullName,
    prNumber: target.prNumber,
    baseSha: target.baseSha,
    headSha: target.headSha,
  };
  const [activeJob, verifyJob] = await Promise.all([
    db.dispatchJob.findFirst({
      where: { ...jobWhere, kind: "RELEASE_REVIEW", status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
      select: { id: true },
    }),
    facts.dependsOnEvidence
      ? db.dispatchJob.findFirst({
          where: { ...jobWhere, kind: "RELEASE_VERIFY", status: { in: ["SUCCEEDED", "FAILED"] } },
          orderBy: { createdAt: "desc" },
          select: { targetHost: true },
        })
      : null,
  ]);
  return decideOpsReevaluation({
    repositoryFullName: target.repoFullName,
    review: facts,
    jobActive: activeJob !== null,
    assessment: assessReleaseOps(findOpsRequest(facts.opsTexts), context),
    hosts: context?.hosts ?? [],
    verifyHost: verifyJob?.targetHost ?? null,
  });
}

/**
 * 画面用: 運用待ちの全体レビューを自動で再評価できるか・できないならその理由（#5111）。
 * 稼働情報は画面の要約が読んだもの（`opsContext`）をそのまま使い、GitHub APIを重ねて呼ばない
 */
export async function explainOpsReevaluation(
  target: ReleaseVerificationTarget,
  context: ReleaseOpsContext | null,
): Promise<OpsReevaluationDecision> {
  const row = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { state: true, findings: true, unverifiedScope: true },
  });
  if (!row) return { action: "none", reason: "not_waiting_ops" };
  return decideOpsReevaluationFor(target, readOpsReviewFacts(row), context);
}

async function installationTokenFor(repoFullName: string): Promise<string | undefined> {
  const repository = await db.repository.findFirst({
    where: { fullName: repoFullName },
    include: { installation: true },
  });
  if (!repository?.installation) return undefined;
  // `app-auth`は読み込み時にApp設定を読む。報告・巡回の経路（とそのテスト）を、照合が要るときまで巻き込まない
  const { getInstallationToken } = await import("@/lib/github/app-auth");
  return getInstallationToken(repository.installation.installationId);
}

export type OpsReevaluateOutcome =
  | OpsReevaluationDecision
  | { action: "skipped"; reason: "no_record" | "not_current" | "no_host" };

/** 運用待ちの全体レビューを、ホストの事実が更新済みなら再評価する（#5111） */
export async function reevaluateReleaseReviewForOps(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<OpsReevaluateOutcome> {
  const row = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { state: true, findings: true, unverifiedScope: true },
  });
  if (!row) return { action: "skipped", reason: "no_record" };
  const facts = readOpsReviewFacts(row);
  if (facts.state !== "needs_check" || !facts.waitsForOps) return { action: "none", reason: "not_waiting_ops" };
  // 候補の取消・完了（公開済み）・SHAの変更後は、古い対象の結果で現候補を上書きしない
  if (!(await isCurrentReleaseReviewTarget(target))) return { action: "skipped", reason: "not_current" };

  // 起動時コミットが候補を含むかの照合はissue-deck自身の候補だけGitHubを読む（他リポジトリは申告した能力だけで決まる）
  let context: ReleaseOpsContext | null = null;
  try {
    const token = target.repoFullName === POLLER_REPOSITORY ? await installationTokenFor(target.repoFullName) : undefined;
    context = await loadReleaseOpsContext(target.repoFullName, { baseSha: target.baseSha, headSha: target.headSha }, token, now);
  } catch (error) {
    console.error(`[release-review-reevaluate] 稼働情報を読めませんでした ${target.repoFullName}:`, error);
  }
  const decision = await decideOpsReevaluationFor(target, facts, context);
  if (decision.action !== "rerun") return decision;

  const result = await rerunReleaseReviewJob(target, now, {
    requiredHost: decision.host,
    recordNoHost: false,
    opsReevaluation: { hostFact: decision.hostFact, requestedAt: now.toISOString() },
  });
  if (!result.ok) return { action: "skipped", reason: "no_host" };
  return decision;
}

const OPS_SWEEP_WINDOW_MS = 14 * 24 * 60 * 60_000;
const OPS_SWEEP_LIMIT = 20;
/** 同じ対象・同じホストの事実を照合し直すまでの間隔。事実が変わればすぐ照合する */
const OPS_RECHECK_MS = 10 * 60_000;
const opsChecked = new Map<string, number>();

/**
 * 巡回での照合（`sweepReleaseReviewReevaluation`に相乗り）。**DBだけで「レビューの実行時・前回の印と違う
 * ホストの事実がある」対象を先に絞り**、その対象にだけ稼働情報（GitHub API）を読む。heartbeatが繰り返されても
 * 起動時コミットが変わらなければ、同じ対象を照合し直すのは10分に1回まで
 */
async function sweepOpsReevaluation(now: Date): Promise<void> {
  const rows = await db.releaseVerification.findMany({
    where: {
      kind: "ai_review",
      state: "needs_check",
      updatedAt: { gte: new Date(now.getTime() - OPS_SWEEP_WINDOW_MS) },
    },
    orderBy: { updatedAt: "desc" },
    take: OPS_SWEEP_LIMIT,
    select: {
      repoFullName: true,
      prNumber: true,
      baseSha: true,
      headSha: true,
      state: true,
      findings: true,
      unverifiedScope: true,
    },
  });
  const waiting = rows.filter((row) => {
    const facts = readOpsReviewFacts(row);
    return facts.waitsForOps && !facts.hasDiagnostic;
  });
  if (waiting.length === 0) return;
  const hosts = await db.dispatchHost.findMany({
    select: { name: true, lastSeenAt: true, repositories: true, checkoutStartedCommit: true, releaseReviewCapable: true },
  });
  for (const key of opsChecked.keys()) {
    if (now.getTime() - (opsChecked.get(key) ?? 0) >= OPS_RECHECK_MS) opsChecked.delete(key);
  }
  for (const row of waiting) {
    const facts = readOpsReviewFacts(row);
    const saved = facts.hostFacts ? hostFactKey(facts.hostFacts.host, facts.hostFacts.startedCommit) : null;
    const keys = hosts
      .filter(
        (h) =>
          h.releaseReviewCapable === true &&
          isDispatchHostOnline(h.lastSeenAt, now) &&
          parseDispatchHostRepositories(h.repositories).includes(row.repoFullName),
      )
      .map((h) => hostFactKey(h.name, h.checkoutStartedCommit))
      .sort();
    if (!keys.some((k) => k !== saved && k !== facts.opsMarker?.hostFact)) continue;
    const memo = `${row.repoFullName}#${row.prNumber}@${row.baseSha}:${row.headSha}|${keys.join(",")}`;
    if (opsChecked.has(memo)) continue;
    opsChecked.set(memo, now.getTime());
    const target = { repoFullName: row.repoFullName, prNumber: row.prNumber, baseSha: row.baseSha, headSha: row.headSha };
    try {
      const outcome = await reevaluateReleaseReviewForOps(target, now);
      if (outcome.action === "rerun") {
        console.info(
          `[release-review-reevaluate] ops-sweep: ${target.repoFullName}#${target.prNumber}@${target.headSha.slice(0, 7)} → rerun（${outcome.hostFact}）`,
        );
      }
    } catch (error) {
      console.error("[release-review-reevaluate] ops-sweep: 自動再評価の判定に失敗しました", error);
    }
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
  await sweepOpsReevaluation(now);
}

/** テスト用: 巡回の間引きを戻す */
export function resetReleaseReviewReevaluationSweepForTest(): void {
  lastSweepAt = 0;
  opsChecked.clear();
}
