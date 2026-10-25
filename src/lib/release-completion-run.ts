import type { ReleaseCompletionRun } from "@prisma/client";
import { legacyReleaseVersionOf } from "@/lib/release-branch";

import { parseClaudeLocalModel, parseCodexLocalModel, resolveAiExecutionAgent } from "@/lib/app-settings";
import { db } from "@/lib/db";
import {
  decideDeployRecoveryRelease,
  deployFailureKey,
  deployRecoveryStage,
  type DeployRecoveryReleaseDecision,
} from "@/lib/deploy-recovery-series";
import { DEPLOY_RECOVERY_SCOPE_DEVELOP, DEPLOY_RECOVERY_SCOPE_MAIN } from "@/lib/deploy-recovery-main-merge";
import {
  fetchDeployRunsForSha,
  hasVersionVerification,
  startDeployRecoverySeries,
  stopDeployRecoverySeries,
  toDeployRecoverySeriesView,
} from "@/lib/deploy-recovery-series-run";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { reevaluateReleaseReviewIfReady } from "@/lib/dispatch/release-review-reevaluate";
import { fetchPullRequest, fetchWorkflowRunJobs, mergePullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { recordDeployLaunchWatch } from "@/lib/github/deploy-launch-watch";
import { addIssueLabels, createComment, removeIssueLabel } from "@/lib/github/issues-api";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { fetchMainHeadSha, fetchPullRequestCiState, type GithubApiPullRequest } from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { loadFinalizationSnapshot, reconcileRcFinalization } from "@/lib/release-finalize-run";
import { isRcReleaseCandidateHeadRef } from "@/lib/release-branch";
import {
  decideCompletionMerge,
  decideReleaseCompletion,
  isReleaseCompletionActive,
  RELEASE_COMPLETION_COST_LIMIT_USD,
  RELEASE_COMPLETION_SCOPE_PRODUCTION,
  RELEASE_COMPLETION_TTL_MS,
  isAiReviewWaivedFor,
  isGateClearedByReviewDecisions,
  waiveAiReviewCheck,
  describeMergeWait,
  isLongMergeWait,
  nextMergeWait,
  releaseCompletionNeedsAction,
  releaseCompletionStageIndex,
  releaseCompletionStatusLabel,
  releaseCompletionStopMessage,
  describeUnverifiedReview,
  reevaluationKeepsWaiting,
  UNVERIFIED_REEVALUATING_NOTE,
  type CompletionCheckState,
  type CompletionFinalizationSnapshot,
  type CompletionChecks,
  type CompletionSeriesSnapshot,
  type ReleaseCompletionDecision,
  type ReleaseCompletionScope,
  type ReleaseCompletionStatus,
  type ReleaseCompletionStopReason,
} from "@/lib/release-completion";
import { classifyIntegrationFailure, isReleaseFixActive } from "@/lib/release-fix-series";
import {
  checkPublishApprovalForRun,
  claimPublishApprovalForMerge,
  revokeApprovalForStoppedRun,
  settlePublishApprovalMerge,
  settlePublishApprovalOnStop,
} from "@/lib/release-publish-approval-run";
import { createReleaseFixSeries, readReleaseFixStartState } from "@/lib/release-fix-series-run";
import { evaluateReleaseMergeGate, isReleasePullRequest } from "@/lib/release-merge-gate";
import { loadReleasePrerequisiteBlockers } from "@/lib/release-prerequisites-run";
import { isProductionVerifiedForMergeSha } from "@/lib/release-production-verification-run";
import { listReleaseVerificationRecords } from "@/lib/release-verification";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";
import { describeIntegrationSetupGap } from "@/lib/release-verification-config";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/**
 * リリース完了系列（#4480）の外部操作。判断は`release-completion.ts`の純関数が持つ。
 *
 * **再起動しても続きから進められる形にする。** 進行はすべて`ReleaseCompletionRun`の行に置き、巡回は
 * `lastSweepAt`の条件付き更新で実行権を取ってから観測→判断→適用する。二重起案は`ReleaseFixSeries.activeKey`、
 * 二重起動は`DispatchJob.activeKey`、二重マージはHEAD指定のマージ（GitHubが409で弾く）と状態の条件付き更新が止める。
 *
 * **世代の進行（修正PRの観測・候補の作り直し・再検証）は`runReleaseFixSweep`が持ち、ここは`ReleaseFixSeries`の状態を
 * 書き換えない。** ここが足すのは、修正Issueの起動・次世代の起案・後継候補への追従・本番マージ・deploy追跡だけ。
 */

const SWEEP_INTERVAL_MS = 30 * 1000;
const CHECK_USER_LABELS = ["00.check-user", "01.check-blocked"];
const MARKER = "<!-- issue-deck-release-completion -->";

type RunRow = ReleaseCompletionRun;

export type ReleaseCompletionRunView = {
  id: string;
  /** 本番マージの条件を待っている理由（日本語1行）。`merging`で待っているときだけ入る（#4725） */
  waitMessage: string | null;
  /** 同じ理由で長く待っていて、人が見るべきか */
  waitStalled: boolean;
  waitSince: string | null;
  repositoryFullName: string;
  status: string;
  statusLabel: string;
  stageIndex: number;
  active: boolean;
  needsAction: boolean;
  scope: string;
  releaseVersion: string | null;
  originPrNumber: number;
  candidatePrNumber: number;
  candidateHeadSha: string;
  candidateBaseSha: string;
  candidatePrNumbers: number[];
  /** 系列が使った修正Issue・修正PR（古い順）と世代 */
  fixes: { issueNumber: number; fixPrNumber: number | null; generation: number; status: string }[];
  costLimitUsd: number;
  costUsedUsd: number;
  mergeSha: string | null;
  mergedByRun: boolean;
  releaseRunUrl: string | null;
  completedAt: string | null;
  note: string | null;
  stopReason: string | null;
  stopMessage: string | null;
  deployRecovery: { id: string; statusLabel: string; issueNumber: number | null; stopMessage: string | null } | null;
  startedByUserId: string;
  /** RCの公開承認（#4666）から始めた系列か */
  fromPublishApproval: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];
}

function splitFullName(fullName: string): [string, string] {
  const [owner, repo] = fullName.split("/");
  return [owner ?? "", repo ?? ""];
}

/** 系列が追ってきた候補に紐づく修正系列（世代）を古い順に返す */
async function loadFixSeries(row: RunRow) {
  const candidates = numbers(row.candidatePrNumbers);
  return db.releaseFixSeries.findMany({
    where: {
      repositoryFullName: row.repositoryFullName,
      releasePrNumber: { in: candidates.length > 0 ? candidates : [row.candidatePrNumber] },
    },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
}

export async function toReleaseCompletionRunView(row: RunRow): Promise<ReleaseCompletionRunView> {
  const fixes = await loadFixSeries(row);
  const recovery = row.deployRecoverySeriesId
    ? await db.deployRecoverySeries.findUnique({ where: { id: row.deployRecoverySeriesId } })
    : null;
  const recoveryView = recovery ? toDeployRecoverySeriesView(recovery) : null;
  const waiting = row.status === "merging";
  return {
    id: row.id,
    waitMessage: waiting ? describeMergeWait(row.waitReason) : null,
    waitStalled: waiting && isLongMergeWait(row.waitSince, new Date()),
    waitSince: waiting ? (row.waitSince?.toISOString() ?? null) : null,
    repositoryFullName: row.repositoryFullName,
    status: row.status,
    statusLabel: releaseCompletionStatusLabel(row.status, Boolean(row.publishApprovalId)),
    stageIndex: releaseCompletionStageIndex(row.status, recoveryView ? deployRecoveryStage(recoveryView.status).index : null),
    active: isReleaseCompletionActive(row.status),
    needsAction: releaseCompletionNeedsAction(row.status),
    scope: row.scope,
    releaseVersion: row.releaseVersion,
    originPrNumber: row.originPrNumber,
    candidatePrNumber: row.candidatePrNumber,
    candidateHeadSha: row.candidateHeadSha,
    candidateBaseSha: row.candidateBaseSha,
    candidatePrNumbers: numbers(row.candidatePrNumbers),
    fixes: fixes.map((s) => ({ issueNumber: s.issueNumber, fixPrNumber: s.fixPrNumber, generation: s.generation, status: s.status })),
    costLimitUsd: row.costLimitUsd,
    costUsedUsd: row.costUsedUsd,
    mergeSha: row.mergeSha,
    mergedByRun: row.mergedByRun,
    releaseRunUrl: row.releaseRunUrl,
    completedAt: row.completedAt?.toISOString() ?? null,
    note: row.note,
    stopReason: row.stopReason,
    stopMessage: releaseCompletionStopMessage(row.stopReason, row.stopDetail),
    deployRecovery: recoveryView
      ? { id: recoveryView.id, statusLabel: recoveryView.statusLabel, issueNumber: recoveryView.issueNumber, stopMessage: recoveryView.stopMessage }
      : null,
    startedByUserId: row.startedByUserId,
    fromPublishApproval: Boolean(row.publishApprovalId),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** このリリースPR（起点か、系列が追従した後継）に関係する最新の系列 */
export async function findReleaseCompletionRunForPullRequest(
  repositoryFullName: string,
  pullRequestNumber: number,
): Promise<ReleaseCompletionRunView | null> {
  const rows = await db.releaseCompletionRun.findMany({
    where: { repositoryFullName },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const row = rows.find((r) => r.candidatePrNumber === pullRequestNumber || numbers(r.candidatePrNumbers).includes(pullRequestNumber));
  return row ? toReleaseCompletionRunView(row) : null;
}

export type StartReleaseCompletionResult =
  | { ok: true; run: ReleaseCompletionRunView; created: boolean }
  | {
      ok: false;
      error: "not_release_pull_request" | "release_pr_changed" | "nothing_to_recover" | "run_active";
      run?: ReleaseCompletionRunView;
    };

/**
 * 「修正を自動で続ける」の開始（#4480）。**対象の候補・SHA・失敗はサーバーがGitHubと記録から読み直す。**
 *
 * 開始できるのは、候補に問題（全体レビューの指摘・統合検証の失敗）があるか、修正系列が記録されている
 * ときだけ。問題の無い候補を本番へ出すのは通常のリリース（人がマージする）で、この系列の対象ではない。
 * 同じリポジトリで系列が進行中なら新しく始めない（`activeKey`の一意制約で原子的に弾く）。
 */
export async function startReleaseCompletionRun(params: {
  owner: string;
  repo: string;
  token: string;
  userId: string;
  pullRequestNumber: number;
  /** 画面で見ていたSHA。今の候補と違えば古い表示から始めない */
  baseSha?: string;
  headSha?: string;
  scope: ReleaseCompletionScope;
  now?: Date;
}): Promise<StartReleaseCompletionResult> {
  const now = params.now ?? new Date();
  const repositoryFullName = `${params.owner}/${params.repo}`;
  const pr = (await fetchPullRequest(params.owner, params.repo, params.pullRequestNumber, params.token)) as GithubApiPullRequest & {
    state?: string;
  };
  if (!pr.base || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) return { ok: false, error: "not_release_pull_request" };
  if (pr.state !== "open") return { ok: false, error: "release_pr_changed" };
  if ((params.baseSha && params.baseSha !== pr.base.sha) || (params.headSha && params.headSha !== pr.head.sha)) {
    return { ok: false, error: "release_pr_changed" };
  }

  const existing = await db.releaseCompletionRun.findUnique({ where: { activeKey: repositoryFullName } });
  if (existing) {
    const view = await toReleaseCompletionRunView(existing);
    if (existing.candidatePrNumber === pr.number) return { ok: true, run: view, created: false };
    return { ok: false, error: "run_active", run: view };
  }

  const summary = await loadReleaseVerificationSummary(repositoryFullName, pr.number, { baseSha: pr.base.sha, headSha: pr.head.sha });
  // 止める指摘の全件をユーザーが修正しないと判断した全体レビューは、復旧すべき問題に数えない（#4657）
  const aiCleared = summary.aiReview.state === "needs_check" && summary.aiReview.decisions?.cleared === true;
  const hasProblem = [aiCleared ? "passed" : summary.aiReview.state, summary.integration.state].some((s) => s === "failed" || s === "needs_check");
  const series = await db.releaseFixSeries.findFirst({
    where: { repositoryFullName, OR: [{ releasePrNumber: pr.number }, { successorPrNumber: pr.number }] },
    select: { id: true },
  });
  if (!hasProblem && !series) return { ok: false, error: "nothing_to_recover" };

  try {
    const created = await db.releaseCompletionRun.create({
      data: {
        repositoryFullName,
        originPrNumber: pr.number,
        originHeadSha: pr.head.sha,
        releaseVersion: legacyReleaseVersionOf(pr.head.ref),
        scope: params.scope,
        startedByUserId: params.userId,
        expiresAt: new Date(now.getTime() + RELEASE_COMPLETION_TTL_MS),
        status: "investigating",
        activeKey: repositoryFullName,
        candidatePrNumber: pr.number,
        candidateHeadSha: pr.head.sha,
        candidateBaseSha: pr.base.sha,
        candidatePrNumbers: [pr.number],
        costLimitUsd: RELEASE_COMPLETION_COST_LIMIT_USD,
      },
    });
    return { ok: true, run: await toReleaseCompletionRunView(created), created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const active = await db.releaseCompletionRun.findUnique({ where: { activeKey: repositoryFullName } });
    return { ok: false, error: "run_active", run: active ? await toReleaseCompletionRunView(active) : undefined };
  }
}

/**
 * 停止。**以後この系列から新しい起動・起案・マージをしない。** 引き継いだ本番復旧があれば、それも止める。
 * 動いている実装セッション・workflowは取り消せない（画面に出す）。
 */
export async function stopReleaseCompletionRun(params: {
  repositoryFullName: string;
  runId: string;
  userId: string;
  token: string;
  now?: Date;
}): Promise<ReleaseCompletionRunView | null> {
  const now = params.now ?? new Date();
  const row = await db.releaseCompletionRun.findFirst({ where: { id: params.runId, repositoryFullName: params.repositoryFullName } });
  if (!row) return null;
  if (!isReleaseCompletionActive(row.status)) return toReleaseCompletionRunView(row);
  await db.releaseCompletionRun.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: "stopped", activeKey: null, stopReason: "stopped_by_user", stoppedByUserId: params.userId, stoppedAt: now },
  });
  // 公開承認から始めた系列を止めたら、その承認も取り消す（止めた後に古い承認から公開しない。#4666）
  if (row.publishApprovalId) await revokeApprovalForStoppedRun(row.publishApprovalId, params.userId, now);
  if (row.deployRecoverySeriesId) {
    await stopDeployRecoverySeries({
      repositoryFullName: row.repositoryFullName,
      seriesId: row.deployRecoverySeriesId,
      userId: params.userId,
      token: params.token,
      now,
    }).catch((error: unknown) => console.error("[release-completion] 引き継いだ本番復旧を止められませんでした", row.id, error));
  }
  const updated = await db.releaseCompletionRun.findUnique({ where: { id: row.id } });
  return updated ? toReleaseCompletionRunView(updated) : null;
}

export type ReleaseCompletionSweepAction = { runId: string; repositoryFullName: string; action: string; detail?: string };

/** pollerから呼ぶ1巡。`hostName`は修正Issueの実装を起動するホスト */
export async function runReleaseCompletionSweep(params: {
  hostName: string;
  now?: Date;
}): Promise<{ scanned: number; actions: ReleaseCompletionSweepAction[] }> {
  const now = params.now ?? new Date();
  const rows = await db.releaseCompletionRun.findMany({ where: { activeKey: { not: null } } });
  const actions: ReleaseCompletionSweepAction[] = [];
  for (const stored of rows) {
    try {
      // 複数のpollerが同時に来ても1本だけが進める。GitHub APIの消費も系列ごとに30秒に1回へ抑える
      const claim = await db.releaseCompletionRun.updateMany({
        where: {
          id: stored.id,
          status: stored.status,
          OR: [{ lastSweepAt: null }, { lastSweepAt: { lt: new Date(now.getTime() - SWEEP_INTERVAL_MS) } }],
        },
        data: { lastSweepAt: now },
      });
      if (claim.count !== 1) continue;
      const action = await advanceRun(stored, params.hostName, now);
      if (action) actions.push({ runId: stored.id, repositoryFullName: stored.repositoryFullName, ...action });
    } catch (error) {
      // 1本の障害で他の系列を止めない。次の巡回で再評価する
      console.error("[runReleaseCompletionSweep]", stored.repositoryFullName, stored.id, error);
    }
  }
  return { scanned: rows.length, actions };
}

type Ctx = { owner: string; repo: string; token: string };
type ActionResult = { action: string; detail?: string } | null;

async function advanceRun(run: RunRow, hostName: string, now: Date): Promise<ActionResult> {
  const repository = await db.repository.findFirst({
    where: { fullName: run.repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  const [owner, repo] = splitFullName(run.repositoryFullName);
  const ctx: Ctx = { owner, repo, token: await getInstallationToken(repository.installation.installationId) };

  // 新方式の候補（#4496）の公開準備・本番反映の段階を進める（人がマージした場合も同じ観測で追う）
  await reconcileRcForRun(run, ctx);
  if (run.status === "releasing" || run.status === "verifying") return advanceRelease(run, ctx, now);
  if (run.status === "deploy_recovery") return advanceDeployRecovery(run, ctx);

  const costUsedUsd = await sumFixCost(run);
  if (costUsedUsd !== run.costUsedUsd) {
    await db.releaseCompletionRun.update({ where: { id: run.id }, data: { costUsedUsd } });
  }
  const current: RunRow = { ...run, costUsedUsd };
  const observation = await observeCandidate(current, ctx);
  // 公開承認（#4666）の系列は、承認が今も範囲内か（候補の更新・置換・mainの前進・取消・期限）を毎巡回確かめる。
  // 候補がマージ済みなら本番反映の追跡へ進むだけなので見ない
  if (current.publishApprovalId && observation.candidate && !observation.candidate.merged) {
    const approval = await checkPublishApprovalForRun(ctx, current, observation.candidate.state === "open" ? { headSha: observation.candidate.headSha } : null, now);
    if (approval?.state === "invalid") return handOff(current, ctx, approval.reason, approval.detail || undefined);
  }
  const decision = decideReleaseCompletion(
    {
      status: current.status as ReleaseCompletionStatus,
      scope: current.scope,
      startedByUserId: current.startedByUserId,
      expiresAt: current.expiresAt,
      stoppedAt: current.stoppedAt,
      candidatePrNumber: current.candidatePrNumber,
      candidateHeadSha: current.candidateHeadSha,
      candidateBaseSha: current.candidateBaseSha,
      dispatchedSeriesId: current.dispatchedSeriesId,
      dispatchedAt: current.dispatchedAt,
      costLimitUsd: current.costLimitUsd,
      costUsedUsd,
      fromPublishApproval: Boolean(current.publishApprovalId),
    },
    { now, candidate: observation.candidate, series: observation.series, checks: observation.checks, finalization: observation.finalization },
  );
  return applyDecision(current, decision, ctx, hostName, now, observation);
}

async function reconcileRcForRun(run: RunRow, ctx: Ctx): Promise<void> {
  const snapshot = await loadFinalizationSnapshot(run.repositoryFullName, run.candidatePrNumber).catch(() => null);
  if (!snapshot) return;
  await reconcileRcFinalization(ctx, snapshot.candidateId).catch((error: unknown) =>
    console.error("[release-completion] 公開準備の進行を確認できませんでした", run.id, error),
  );
}

/** 修正Issueのセッションで使った額（API換算の目安）。系列の開始より後の分だけ数える */
async function sumFixCost(run: RunRow): Promise<number> {
  const issues = [...new Set((await loadFixSeries(run)).filter((s) => s.createdAt >= run.createdAt || isReleaseFixActive(s.status)).map((s) => s.issueNumber))];
  if (issues.length === 0) return run.costUsedUsd;
  const [, repo] = splitFullName(run.repositoryFullName);
  const total = await db.sessionUsage.aggregate({
    where: { repository: repo, issueNumber: { in: issues }, endedAt: { gte: run.createdAt } },
    _sum: { costUsd: true },
  });
  return Math.round((total._sum.costUsd ?? 0) * 100) / 100;
}

type CandidatePull = GithubApiPullRequest & {
  state?: "open" | "closed";
  merged?: boolean;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  labels?: { name?: string }[];
};

type Observation = {
  candidate: { number: number; state: "open" | "closed"; merged: boolean; headSha: string; baseSha: string; mergeCommitSha: string | null } | null;
  pull: CandidatePull | null;
  series: CompletionSeriesSnapshot | null;
  checks: CompletionChecks | null;
  summary: ReleaseVerificationSummary | null;
  /** 新方式の候補（#4496）の公開準備。旧方式はnull */
  finalization: CompletionFinalizationSnapshot | null;
};

async function observeCandidate(run: RunRow, ctx: Ctx): Promise<Observation> {
  const pull = (await fetchPullRequest(ctx.owner, ctx.repo, run.candidatePrNumber, ctx.token).catch(() => null)) as CandidatePull | null;
  const candidate =
    pull && pull.base
      ? {
          number: pull.number,
          state: pull.state === "closed" ? ("closed" as const) : ("open" as const),
          merged: pull.merged === true,
          headSha: pull.head.sha,
          baseSha: pull.base.sha,
          mergeCommitSha: pull.merge_commit_sha ?? null,
        }
      : null;

  const latest = await db.releaseFixSeries.findFirst({
    where: {
      repositoryFullName: run.repositoryFullName,
      OR: [{ releasePrNumber: run.candidatePrNumber }, { successorPrNumber: run.candidatePrNumber }],
    },
    orderBy: { createdAt: "desc" },
  });
  const series: CompletionSeriesSnapshot | null = latest
    ? {
        id: latest.id,
        status: latest.status,
        issueNumber: latest.issueNumber,
        fixPrNumber: latest.fixPrNumber,
        stopReason: latest.stopReason,
        successorPrNumber: latest.successorPrNumber,
        successorHeadSha: latest.successorHeadSha,
        successorBaseSha: latest.successorBaseSha,
        startState: latest.status === "issue_created" ? await readReleaseFixStartState(run.repositoryFullName, latest.issueNumber) : "none",
      }
    : null;

  // 検証は、記録した候補のSHAのまま開いているときだけ読む（他のSHAの結果で判断しない）
  let summary: ReleaseVerificationSummary | null = null;
  if (candidate && candidate.state === "open" && candidate.headSha === run.candidateHeadSha) {
    summary = await loadReleaseVerificationSummary(run.repositoryFullName, run.candidatePrNumber, {
      baseSha: candidate.baseSha,
      headSha: candidate.headSha,
    }).catch(() => null);
  }
  // 新方式の候補は、正式バンプ（公開準備）と最終検証が済むまで公開へ進めない
  const finalization =
    pull && isRcReleaseCandidateHeadRef(pull.head.ref)
      ? await loadFinalizationSnapshot(run.repositoryFullName, run.candidatePrNumber).catch(() => null)
      : null;
  return {
    candidate,
    pull,
    series,
    checks: summary
      ? waiveAiReviewCheck(toCompletionChecks(summary, run.repositoryFullName), isAiReviewWaivedFor(finalization, candidate?.headSha ?? ""))
      : null,
    summary,
    // 新方式なのに記録が無い（取得できない）ときも「公開準備が済んでいない」として扱う（旧方式と見なして進めない）
    finalization: pull && isRcReleaseCandidateHeadRef(pull.head.ref) ? (finalization ?? { phase: "review", applied: null, latest: null }) : null,
  };
}

export function toCompletionChecks(summary: ReleaseVerificationSummary, repositoryFullName: string): CompletionChecks {
  const fold = (state: string): CompletionCheckState => {
    switch (state) {
      case "passed":
      case "failed":
      case "needs_check":
      case "not_applicable":
      case "not_run":
      case "invalidated":
        return state;
      default:
        return "pending";
    }
  };
  const mac = summary.mac.state;
  return {
    aiReview: fold(summary.aiReview.state),
    integration: fold(summary.integration.state),
    mac: mac === "running" ? "pending" : mac,
    findingCount: summary.aiReview.findings.length,
    integrationFailureKind:
      summary.integration.state === "failed" || summary.integration.state === "needs_check"
        ? classifyIntegrationFailure([summary.integration.reason, summary.integration.summary].filter(Boolean).join("\n"))
        : null,
    integrationSetupGap: describeIntegrationSetupGap(repositoryFullName) !== null,
    aiReviewClearedByDecision: summary.aiReview.decisions?.cleared === true,
    aiReviewUnverified: describeUnverifiedReview({
      state: summary.aiReview.state,
      findingCount: summary.aiReview.findings.length,
      stage: summary.aiReview.stage,
      unverifiedScope: summary.aiReview.unverifiedScope ?? null,
    }),
  };
}

async function applyDecision(
  run: RunRow,
  decision: ReleaseCompletionDecision,
  ctx: Ctx,
  hostName: string,
  now: Date,
  observation: Observation,
): Promise<ActionResult> {
  switch (decision.action) {
    case "wait": {
      const status = decision.status;
      const note = decision.note === undefined ? run.note : decision.note;
      if ((status && status !== run.status) || note !== run.note) {
        await db.releaseCompletionRun.updateMany({
          where: { id: run.id, status: run.status },
          data: { ...(status ? { status } : {}), note },
        });
        return status && status !== run.status ? { action: `transition:${status}` } : null;
      }
      return null;
    }
    case "stop":
      return handOff(run, ctx, decision.reason, decision.detail);
    case "follow_successor": {
      const updated = await db.releaseCompletionRun.updateMany({
        // 新方式の候補（#4495）は番号が変わらずheadが進むので、headも条件にして同時の巡回で二重に進めない
        where: { id: run.id, status: run.status, candidatePrNumber: run.candidatePrNumber, candidateHeadSha: run.candidateHeadSha },
        data: {
          candidatePrNumber: decision.prNumber,
          candidateHeadSha: decision.headSha,
          candidateBaseSha: decision.baseSha,
          candidatePrNumbers: [...new Set([...numbers(run.candidatePrNumbers), decision.prNumber])],
          status: "checking",
          note: null,
        },
      });
      return updated.count === 1 ? { action: "follow_successor", detail: `#${decision.prNumber}` } : null;
    }
    case "reevaluate_review":
      return reevaluateUnverifiedReview(run, ctx, observation);
    case "dispatch_fix":
      return dispatchFix(run, decision.seriesId, decision.issueNumber, ctx, hostName, now);
    case "create_fix":
      return createNextFix(run, decision.sourceKind, ctx, observation);
    case "begin_release": {
      const updated = await db.releaseCompletionRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: "releasing", mergeSha: decision.mergeSha, releaseStartedAt: now, note: null },
      });
      if (updated.count !== 1) return null;
      // マージ応答のSHAが欠けた場合も、PRから確定したSHAで起動監視を登録する。
      // 既存の監視はupsertにより保持される。
      await recordDeployLaunchWatch({
        owner: ctx.owner,
        repo: ctx.repo,
        pullRequestNumber: run.candidatePrNumber,
        mergeCommitSha: decision.mergeSha,
        token: ctx.token,
      }).catch((error: unknown) => console.error("[release-completion] デプロイの見張りを置けませんでした", run.id, error));
      return { action: "begin_release", detail: decision.mergeSha };
    }
    case "evaluate_merge":
      return evaluateAndMerge(run, ctx, now, observation);
  }
}

/** 修正Issueの実装を起動する。同じ系列（世代）は1回だけ。起動の重複は`DispatchJob.activeKey`が弾く */
async function dispatchFix(run: RunRow, seriesId: string, issueNumber: number, ctx: Ctx, hostName: string, now: Date): Promise<ActionResult> {
  // 先に記録して実行権を取る。取れなければ別の巡回が起動している
  const claimed = await db.releaseCompletionRun.updateMany({
    where: { id: run.id, status: run.status, OR: [{ dispatchedSeriesId: null }, { dispatchedSeriesId: { not: seriesId } }] },
    data: { dispatchedSeriesId: seriesId, dispatchedAt: now, status: "fixing", note: null },
  });
  if (claimed.count !== 1) return null;
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { defaultDispatchAgent: true, aiExecutionProvider: true, claudeLocalModel: true, codexModel: true },
  });
  const enqueued = await enqueueDispatchJob({
    repositoryFullName: run.repositoryFullName,
    issueNumber,
    hostName,
    agent: resolveAiExecutionAgent(setting?.defaultDispatchAgent, setting?.aiExecutionProvider),
    claudeModel: parseClaudeLocalModel(setting?.claudeLocalModel),
    codexModel: parseCodexLocalModel(setting?.codexModel),
    requestedByUserId: run.startedByUserId,
    now,
  });
  const alreadyRunning = !enqueued.ok && (enqueued.rejection === "already_queued" || enqueued.rejection === "session_alive");
  if (!enqueued.ok && !alreadyRunning) {
    if (enqueued.rejection === "agent_paused" || enqueued.rejection === "host_offline") {
      // 一時的な理由は次の巡回でやり直す（期限を過ぎれば止まる）
      await db.releaseCompletionRun.updateMany({ where: { id: run.id, dispatchedSeriesId: seriesId }, data: { dispatchedSeriesId: null, dispatchedAt: null, note: enqueued.message } });
      return { action: "deferred", detail: enqueued.message };
    }
    return handOff({ ...run, status: "fixing" }, ctx, "dispatch_failed", enqueued.message);
  }
  await addIssueLabels(ctx.owner, ctx.repo, issueNumber, ctx.token, [LOCAL_LABEL_NAME]).catch((error: unknown) => {
    console.error("[release-completion] 11.localを付けられませんでした", run.id, error);
  });
  return { action: "dispatched", detail: `#${issueNumber}` };
}

/** 現在の候補の指摘・失敗から、修正系列の次の世代を起案する（同じ修正Issueへ戻す既存の流れ） */
async function createNextFix(
  run: RunRow,
  sourceKind: "review_finding" | "integration_failure",
  ctx: Ctx,
  observation: Observation,
): Promise<ActionResult> {
  const pull = observation.pull;
  const summary = observation.summary;
  if (!pull?.base || !summary) return null;
  const section = sourceKind === "review_finding" ? summary.aiReview : summary.integration;
  const result = await createReleaseFixSeries({
    userId: run.startedByUserId,
    owner: ctx.owner,
    repo: ctx.repo,
    token: ctx.token,
    releasePr: pull,
    sourceKind,
    findingIndexes: section.findings.map((_, index) => index),
    causeClass: "code",
    decisionQuestion: null,
    acknowledgeExecutionFailure: false,
    section,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
  });
  if ("series" in result) {
    await db.releaseCompletionRun.updateMany({ where: { id: run.id, status: run.status }, data: { status: "fixing", note: null } });
    return { action: `fix_${result.outcome}`, detail: `#${result.series.issueNumber}` };
  }
  if (result.outcome === "execution_failure") return handOff(run, ctx, "execution_failure");
  return handOff(run, ctx, "fix_blocked", result.message);
}

/** 本番mainへの自動マージ。マージ直前に候補・main・検証・CIを取り直して`decideCompletionMerge`で判定する */
async function evaluateAndMerge(run: RunRow, ctx: Ctx, now: Date, observation: Observation): Promise<ActionResult> {
  const pull = observation.pull;
  const [mainSha, ci, records] = await Promise.all([
    fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token),
    fetchPullRequestCiState(ctx.owner, ctx.repo, run.candidatePrNumber, ctx.token).catch(() => null),
    listReleaseVerificationRecords(run.repositoryFullName, run.candidatePrNumber),
  ]);
  const prerequisites = pull?.base ? await loadReleasePrerequisiteBlockers(run.repositoryFullName, run.candidatePrNumber) : [];
  const gate = pull?.base
    ? evaluateReleaseMergeGate({
        current: { baseSha: pull.base.sha, headSha: pull.head.sha },
        records,
        enforced: true,
        prerequisites,
        aiReviewWaived: isAiReviewWaivedFor(observation.finalization, pull.head.sha),
      })
    : null;
  const mac = observation.checks?.mac;
  const decision = decideCompletionMerge({ ...run, status: run.status as ReleaseCompletionStatus }, {
    now,
    finalization: observation.finalization,
    pullRequest:
      pull && pull.base
        ? {
            number: pull.number,
            state: pull.state === "closed" ? "closed" : "open",
            merged: pull.merged === true,
            baseRef: pull.base.ref,
            headRef: pull.head.ref,
            headSha: pull.head.sha,
            baseSha: pull.base.sha,
            mergeable: pull.mergeable ?? ci?.mergeable ?? null,
            labels: (pull.labels ?? []).map((label) => label.name ?? ""),
          }
        : null,
    mainSha,
    gateStatus: gate && gate.status !== "not_enforced" ? gate.status : "blocked",
    gateReasons: [...(gate?.blockers.map((b) => b.reason) ?? []), ...(gate?.prerequisites.map((b) => `${b.reason}（次: ${b.next}）`) ?? [])],
    // 判断の要約は、いまマージしようとしている対象（base・head）について読んだものだけを使う
    gateClearedByDecision:
      gate !== null &&
      Boolean(pull?.base?.sha) &&
      observation.summary?.target?.baseSha === pull?.base?.sha &&
      observation.summary?.target?.headSha === pull?.head.sha &&
      isGateClearedByReviewDecisions({
        gateStatus: gate.status,
        blockers: gate.blockers,
        aiReviewCleared: observation.summary?.aiReview.decisions?.cleared === true,
      }),
    macOk: mac === "passed" || mac === "not_applicable",
    ciState: ci?.ciState ?? "unknown",
    // 承認の範囲はこの巡回の先頭（`checkPublishApprovalForRun`）で確かめ済み。確保はマージの直前に取り直す
    publishApprovalValid: run.publishApprovalId ? true : undefined,
  });
  if (decision.action === "wait") {
    if (run.status !== "merging") {
      // 別の期間の古い待ち理由を引き継がないよう、入り直しでは待ち始めを取り直す
      await db.releaseCompletionRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: "merging", note: null, waitReason: decision.reason, waitSince: now },
      });
      return { action: "transition:merging", detail: decision.reason };
    }
    const next = nextMergeWait({ reason: run.waitReason, since: run.waitSince }, decision.reason, now);
    if (!next) return null;
    await db.releaseCompletionRun.updateMany({
      where: { id: run.id, status: "merging" },
      data: { waitReason: next.reason, waitSince: next.since },
    });
    return { action: "wait_reason_changed", detail: decision.reason };
  }
  if (decision.action === "stop") return handOff(run, ctx, decision.reason, decision.detail);

  // 直前に停止・別の巡回で状態が動いていないことを条件付き更新で確かめてからマージする
  const claimed = await db.releaseCompletionRun.updateMany({
    where: { id: run.id, status: run.status, stoppedAt: null, activeKey: { not: null } },
    data: { status: "merging" },
  });
  if (claimed.count !== 1) return null;
  let merged: { sha: string | null };
  try {
    const current = await db.releaseCompletionRun.findUnique({
      where: { id: run.id },
      select: { status: true, stoppedAt: true, activeKey: true },
    });
    if (current?.status !== "merging" || current.stoppedAt !== null || current.activeKey === null) {
      return { action: "stopped_before_merge" };
    }
    // 公開承認の系列は、承認を`merging`へ確保できたときだけマージする（取消・失効・期限切れと競合したら進めない）
    if (run.publishApprovalId && !(await claimPublishApprovalForMerge(run.publishApprovalId, now))) {
      return handOff({ ...run, status: "merging" }, ctx, "approval_invalidated", "本番マージの直前に公開承認が取り消された、または失効しました");
    }
    merged = await mergePullRequest(ctx.owner, ctx.repo, run.candidatePrNumber, ctx.token, decision.expectedHeadSha);
  } catch (error) {
    if (run.publishApprovalId) await settlePublishApprovalMerge(run.publishApprovalId, { merged: false }, now);
    return handOff({ ...run, status: "merging" }, ctx, "merge_failed", error instanceof Error ? error.message.slice(0, 200) : undefined);
  }
  if (run.publishApprovalId) await settlePublishApprovalMerge(run.publishApprovalId, { merged: true, mergeSha: merged.sha }, now);
  await db.releaseCompletionRun.updateMany({
    where: { id: run.id, status: "merging" },
    data: merged.sha
      ? { status: "releasing", mergeSha: merged.sha, mergedByRun: true, releaseStartedAt: now, note: null }
      : { mergedByRun: true, note: null },
  });
  // マージイベントの配送漏れに備えて、本番デプロイの起動を見張る（#2703。失敗してもマージは成功のまま）
  await recordDeployLaunchWatch({
    owner: ctx.owner,
    repo: ctx.repo,
    pullRequestNumber: run.candidatePrNumber,
    mergeCommitSha: merged.sha,
    token: ctx.token,
  }).catch((error: unknown) => console.error("[release-completion] デプロイの見張りを置けませんでした", run.id, error));
  await notify(run, ctx, `リリース候補 #${run.candidatePrNumber} を本番mainへマージしました（リリース完了系列の許可範囲内・HEAD \`${run.candidateHeadSha.slice(0, 7)}\`）。デプロイと稼働中の版を確認します。`, false);
  return { action: "merged", detail: merged.sha ?? undefined };
}

/** 本番へ出したあとの追跡（#4007の判定を使う）。再実行も失敗したら本番復旧系列へ引き継ぐ */
async function advanceRelease(run: RunRow, ctx: Ctx, now: Date): Promise<ActionResult> {
  if (!run.mergeSha || !run.releaseStartedAt) return handOff(run, ctx, "release_timed_out");
  const runs = await fetchDeployRunsForSha(ctx.owner, ctx.repo, run.mergeSha, ctx.token);
  const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  // deploy.ymlが稼働SHAを照合しないrepoは、候補側の稼働版の確認（公開URLの照合・人の確認。#4713）の結果を使う
  const versionVerified =
    latest?.status === "completed" && latest.conclusion === "success"
      ? (await hasVersionVerification(ctx.owner, ctx.repo, latest, ctx.token)) || (await isProductionVerifiedForMergeSha(run.repositoryFullName, run.mergeSha))
      : false;
  let failureKey: string | null = null;
  if (latest?.status === "completed" && latest.conclusion !== "success" && latest.conclusion !== "cancelled") {
    const jobs = await fetchWorkflowRunJobs(ctx.owner, ctx.repo, latest.id, ctx.token).catch(() => []);
    failureKey = deployFailureKey(latest.conclusion, jobs.filter((job) => job.conclusion === "failure").map((job) => job.name ?? "不明"));
  }
  const decision: DeployRecoveryReleaseDecision = decideDeployRecoveryRelease(
    { releaseSha: run.mergeSha, releaseStartedAt: run.releaseStartedAt, releaseAttempts: 0, lastFailureKey: null },
    { now, runs, versionVerified, failureKey },
  );
  switch (decision.action) {
    case "wait":
      return null;
    case "track": {
      const runId = BigInt(decision.run.id);
      if (run.status === decision.status && run.releaseRunId === runId) return null;
      await db.releaseCompletionRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: decision.status, releaseRunId: runId, releaseRunUrl: decision.run.htmlUrl },
      });
      return { action: `transition:${decision.status}`, detail: decision.run.htmlUrl };
    }
    case "recovered": {
      const updated = await db.releaseCompletionRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: "completed", activeKey: null, completedAt: now, releaseRunId: BigInt(decision.run.id), releaseRunUrl: decision.run.htmlUrl },
      });
      if (updated.count === 1) {
        await notify(run, ctx, `リリースが完了しました。デプロイが成功し、稼働中の版が \`${run.mergeSha.slice(0, 7)}\` と一致しています。\n\n- デプロイ: ${decision.run.htmlUrl}`, false);
        await clearStopLabels(run, ctx);
      }
      return updated.count === 1 ? { action: "completed", detail: decision.run.htmlUrl } : null;
    }
    case "requeue":
      return handOffDeployFailure(run, ctx, decision.run.id);
    case "stop":
      return handOff(run, ctx, mapReleaseStop(decision.reason), decision.detail);
  }
}

function mapReleaseStop(reason: string): ReleaseCompletionStopReason {
  switch (reason) {
    case "deploy_not_started":
    case "deploy_cancelled":
    case "version_unverified":
    case "deploy_failed":
      return reason;
    default:
      return "release_timed_out";
  }
}

/**
 * deployが再実行も失敗した。**同じ論理系列のまま**、既存の本番復旧系列（#4451）へ失敗を渡して原因の調査・修正・
 * 復旧PR・稼働確認を続けさせ、その状態をこの系列の現在状態として出す。mainへの自動マージを許すのは、開始者が
 * 本番まで許可した系列だけ。
 */
async function handOffDeployFailure(run: RunRow, ctx: Ctx, failedRunId: number): Promise<ActionResult> {
  const started = await startDeployRecoverySeries({
    repositoryFullName: run.repositoryFullName,
    runId: failedRunId,
    userId: run.startedByUserId,
    token: ctx.token,
    scope: run.scope === RELEASE_COMPLETION_SCOPE_PRODUCTION ? DEPLOY_RECOVERY_SCOPE_MAIN : DEPLOY_RECOVERY_SCOPE_DEVELOP,
  }).catch(() => null);
  if (!started) return handOff(run, ctx, "deploy_failed");
  if (!started.ok) {
    return handOff(run, ctx, started.error === "series_active" ? "deploy_recovery_busy" : "deploy_failed", started.error);
  }
  const updated = await db.releaseCompletionRun.updateMany({
    where: { id: run.id, status: run.status },
    data: { status: "deploy_recovery", deployRecoverySeriesId: started.series.id, note: null },
  });
  if (updated.count === 1) {
    await notify(run, ctx, "本番デプロイが再実行も失敗しました。同じ系列のまま、本番復旧（原因の調査・修正・稼働確認）へ引き継ぎます。", false);
  }
  return updated.count === 1 ? { action: "deploy_recovery", detail: started.series.id } : null;
}

async function advanceDeployRecovery(run: RunRow, ctx: Ctx): Promise<ActionResult> {
  if (!run.deployRecoverySeriesId) return handOff(run, ctx, "deploy_recovery_failed");
  const series = await db.deployRecoverySeries.findUnique({ where: { id: run.deployRecoverySeriesId } });
  if (!series) return handOff(run, ctx, "deploy_recovery_failed");
  if (series.status === "recovered") {
    const updated = await db.releaseCompletionRun.updateMany({
      where: { id: run.id, status: run.status },
      data: { status: "completed", activeKey: null, completedAt: series.recoveredAt ?? new Date(), releaseRunUrl: series.releaseRunUrl },
    });
    if (updated.count === 1) await clearStopLabels(run, ctx);
    return updated.count === 1 ? { action: "completed" } : null;
  }
  if (series.status === "needs_attention" || series.status === "stopped" || series.status === "awaiting_release") {
    const view = toDeployRecoverySeriesView(series);
    return handOff(run, ctx, "deploy_recovery_failed", view.stopMessage ?? view.statusLabel);
  }
  return null;
}

/**
 * 指摘0件で未確認範囲だけが残った全体レビューを、統合検証の結果で再評価する（#4768）。積むのは既存の自動再評価
 * （`reevaluateReleaseReviewIfReady`。重複は記録の印とジョブが止める）で、積めた・実行中なら待つ。
 * 待っても変わらない（再評価の対象外など）ときは、理由を示して止める
 */
async function reevaluateUnverifiedReview(run: RunRow, ctx: Ctx, observation: Observation): Promise<ActionResult> {
  const candidate = observation.candidate;
  if (!candidate) return null;
  const outcome = await reevaluateReleaseReviewIfReady({
    repoFullName: run.repositoryFullName,
    prNumber: candidate.number,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
  }).catch((error: unknown) => {
    console.error("[release-completion] 全体レビューの再評価を積めませんでした", run.id, error);
    return { action: "skipped" as const, reason: "no_host" as const };
  });
  if (!reevaluationKeepsWaiting(outcome)) {
    return handOff(run, ctx, "review_unverified", observation.checks?.aiReviewUnverified?.detail ?? undefined);
  }
  if (run.status !== "checking" || run.note !== UNVERIFIED_REEVALUATING_NOTE) {
    await db.releaseCompletionRun.updateMany({
      where: { id: run.id, status: run.status },
      data: { status: "checking", note: UNVERIFIED_REEVALUATING_NOTE },
    });
  }
  return outcome.action === "rerun" ? { action: "reevaluate_review" } : null;
}

/** 止めて人へ渡す。系列を終端にし、理由を修正Issue（無ければ候補のPR）へ残す */
async function handOff(run: RunRow, ctx: Ctx, reason: ReleaseCompletionStopReason, detail?: string): Promise<ActionResult> {
  const updated = await db.releaseCompletionRun.updateMany({
    where: { id: run.id, status: run.status },
    data: { status: "needs_attention", activeKey: null, stopReason: reason, stopDetail: detail ?? null },
  });
  if (updated.count !== 1) return null;
  if (run.publishApprovalId) await settlePublishApprovalOnStop(run.publishApprovalId, reason, new Date());
  await notify(run, ctx, `${run.publishApprovalId ? "自動公開" : "リリース完了系列"}を止めました。${releaseCompletionStopMessage(reason, detail ?? null) ?? ""}`, true);
  return { action: `stop:${reason}`, detail };
}

/**
 * 完了したとき、この候補の系列が過去に止めて付けた確認待ちラベルを修正Issueから外す。人が再開した時点で
 * 確認待ちは解消しているため。外すのは、同じ候補で系列が止まった記録（stopReason）があるときだけ
 * （止まらず完了した場合や、人が別の理由で付けた札には触れない）。
 */
async function clearStopLabels(run: RunRow, ctx: Ctx): Promise<void> {
  try {
    const stopped = run.stopReason
      ? 1
      : await db.releaseCompletionRun.count({
          where: { repositoryFullName: run.repositoryFullName, candidatePrNumber: run.candidatePrNumber, stopReason: { not: null }, id: { not: run.id } },
        });
    if (!stopped) return;
    const latest = await db.releaseFixSeries.findFirst({
      where: { repositoryFullName: run.repositoryFullName, releasePrNumber: { in: numbers(run.candidatePrNumbers) } },
      orderBy: { createdAt: "desc" },
      select: { issueNumber: true },
    });
    if (!latest) return;
    for (const label of CHECK_USER_LABELS) {
      await removeIssueLabel(ctx.owner, ctx.repo, latest.issueNumber, ctx.token, label);
    }
  } catch (error) {
    console.error("[release-completion] 確認待ちラベルの除去に失敗しました", run.id, error);
  }
}

async function notify(run: RunRow, ctx: Ctx, message: string, needsUser: boolean): Promise<void> {
  const latest = await db.releaseFixSeries.findFirst({
    where: { repositoryFullName: run.repositoryFullName, releasePrNumber: { in: numbers(run.candidatePrNumbers) } },
    orderBy: { createdAt: "desc" },
    select: { issueNumber: true },
  });
  const target = latest?.issueNumber ?? run.candidatePrNumber;
  const body = [message, "", `- リリース候補: #${run.candidatePrNumber}`, "", MARKER, "<!-- issue-deck-agent:guide -->"].join("\n");
  await createComment(ctx.owner, ctx.repo, target, ctx.token, { body }).catch((error: unknown) =>
    console.error("[release-completion] コメントに失敗しました", run.id, error),
  );
  if (needsUser && latest) {
    await addIssueLabels(ctx.owner, ctx.repo, latest.issueNumber, ctx.token, CHECK_USER_LABELS).catch(() => undefined);
  }
}
