import { db } from "@/lib/db";
import { requestReleaseReviewJob } from "@/lib/dispatch/release-review-jobs";
import { requestReleaseVerifyJob } from "@/lib/dispatch/release-verify-jobs";
import {
  decideDeployRecoveryRelease,
  type DeployRecoveryReleaseDecision,
} from "@/lib/deploy-recovery-series";
import { fetchDeployRunsForSha, hasVersionVerification } from "@/lib/deploy-recovery-series-run";
import { markPullRequestReadyForReview } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import {
  createPullRequest,
  dispatchReleaseFinalizeWorkflow,
  fetchBranchHeadSha,
  fetchOpenPullRequestsForBase,
  fetchCompareChangedFiles,
  fetchFileTextAtRef,
  fetchMainHeadSha,
  fetchPullRequestCiState,
  fetchReleaseCallerText,
  fetchTagRefs,
  isAncestorCommit,
} from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import {
  buildInheritanceEvidence,
  decideFinalizeFailureHandling,
  decideFinalizeReadiness,
  decideFinalizeReport,
  decideFinalizeStart,
  decideInheritedVerification,
  decideReservationRelease,
  decideVersionReservation,
  FINALIZE_READINESS_LABEL,
  FINALIZE_START_ERROR_LABEL,
  FINALIZE_STATUS_LABEL,
  isFinalizePendingExpired,
  parseFinalizeCallerSupport,
  parseInheritanceEvidence,
  readVersionFromText,
  serializeFinalizeWorkflowRequest,
  type FinalizeCallerSupport,
  type FinalizeReadiness,
  type FinalizeStartDecision,
  type FinalizeStatus,
  type FinalizeVerificationKind,
  type InheritanceEvidence,
  type VersionReservationRow,
  type VersionReservationStatus,
} from "@/lib/release-finalize";
import { evaluateReleaseMergeGate, RELEASE_VERIFICATION_KINDS, type ReleaseVerificationKind } from "@/lib/release-merge-gate";
import { listReleaseMacRows } from "@/lib/release-mac-verification";
import {
  loadCandidateRow,
  loadRcOverview,
  observeCandidatePullRequest,
  type CandidateRow,
  type Context,
} from "@/lib/release-rc-run";
import { canTransitionRcPhase, parseRcPhase, type RcPhase } from "@/lib/release-rc";
import { listReleaseVerificationRecords, registerReleaseVerification, type ReleaseVerificationTarget } from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import { BUMP_KINDS, type BumpKind } from "@/lib/semver-bump";

/**
 * 公開準備（正式バンプ。#4496）の外部操作。判断は`release-finalize.ts`の純関数が持つ。
 *
 * - **始められるのは合格した候補だけ。** レビュー・修正中は版を上げない（`decideFinalizeStart`）
 * - 要求・版の予約は要求キーと`pendingKey`・`ReleaseVersionReservation`のユニーク制約で冪等にする。
 *   workflowの報告は信じず、候補ブランチ・版ファイル・差分をGitHubから取り直して照合する
 * - バンプ後のheadは`finalize_bump`のrevisionとして記録する（修正工程へ戻っても候補の履歴が途切れない）
 * - バンプ前の検証行は書き換えない。引継ぎは証跡（`handoffEvidence`）に残し、画面・判定が派生の記録として読む
 * - 公開前の失敗は同じ候補の`review`へ戻し、版の予約は保つ。mainへ入った版は消費済みにして再利用しない
 */

type PullDetail = Awaited<ReturnType<typeof fetchPullRequest>>;
type FinalizationRow = NonNullable<Awaited<ReturnType<typeof loadFinalizationRows>>>[number];

const fullNameOf = (ctx: Context) => `${ctx.owner}/${ctx.repo}`;

async function loadFinalizationRows(candidateId: string) {
  return db.releaseCandidateFinalization.findMany({ where: { candidateId }, orderBy: { createdAt: "asc" } });
}

// ---------------------------------------------------------------------------
// 画面に出す形

export type RcFinalizationView = {
  id: string;
  status: FinalizeStatus;
  statusLabel: string;
  revision: number;
  prNumber: number;
  preBaseSha: string;
  preHeadSha: string;
  finalBaseSha: string | null;
  finalHeadSha: string | null;
  /** 確定した版。自動判定でまだ決まっていなければnull（検証中の予定値は確定済みとして出さない） */
  version: string | null;
  versionReservation: VersionReservationStatus | null;
  bumpKind: BumpKind | null;
  bumpKindSource: "auto" | "manual";
  evidence: InheritanceEvidence[];
  files: { path: string; category: string }[];
  runUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type RcFinalizationChecks = {
  /** バンプ後のheadの最終CI・ビルド */
  ciState: "pending" | "success" | "failure" | "unknown";
  draft: boolean;
  /** 再実行が必要で、まだ合格していない検証 */
  pendingReverify: FinalizeVerificationKind[];
  readiness: FinalizeReadiness;
  readinessLabel: string | null;
};

export type RcFinalizationOverview = {
  caller: FinalizeCallerSupport & { reasonLabel: string | null };
  /** 現在の版の予定（mainの版）。手動指定の目安に使う。読めなければnull */
  mainVersion: string | null;
  /** 最新の公開準備（無ければnull） */
  current: RcFinalizationView | null;
  checks: RcFinalizationChecks | null;
  /** 過去の公開準備（失敗・置き換え済み）。記録として残す */
  history: RcFinalizationView[];
};

function toView(row: FinalizationRow, reservation: { status: string } | null): RcFinalizationView {
  const diff = Array.isArray(row.diffFiles) ? (row.diffFiles as { path: string; category: string }[]) : [];
  return {
    id: row.id,
    status: row.status as FinalizeStatus,
    statusLabel: FINALIZE_STATUS_LABEL[row.status as FinalizeStatus] ?? row.status,
    revision: row.revision,
    prNumber: row.prNumber,
    preBaseSha: row.preBaseSha,
    preHeadSha: row.preHeadSha,
    finalBaseSha: row.finalBaseSha,
    finalHeadSha: row.finalHeadSha,
    version: row.reservedVersion,
    versionReservation: reservation ? (reservation.status as VersionReservationStatus) : null,
    bumpKind: row.bumpKind && (BUMP_KINDS as readonly string[]).includes(row.bumpKind) ? (row.bumpKind as BumpKind) : null,
    bumpKindSource: row.bumpKindSource === "manual" ? "manual" : "auto",
    evidence: parseInheritanceEvidence(row.handoffEvidence),
    files: diff.filter((f) => typeof f?.path === "string"),
    runUrl: row.runUrl,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// 版の予約

const repoTags = async (ctx: Context): Promise<string[]> =>
  (await fetchTagRefs(ctx.owner, ctx.repo, ctx.token, "v").catch(() => [])).map((t) => t.ref.replace("refs/tags/", ""));

async function loadReservations(repositoryFullName: string): Promise<(VersionReservationRow & { id: string })[]> {
  const rows = await db.releaseVersionReservation.findMany({ where: { repositoryFullName } });
  return rows.map((r) => ({ id: r.id, version: r.version, candidateId: r.candidateId, status: r.status as VersionReservationStatus }));
}

/** 版を予約する。手放した版は取り直し、同時に取った側が負ければ`false`（ユニーク制約が競合を止める） */
async function reserveVersion(input: { repositoryFullName: string; candidateId: string; version: string; release: string[] }): Promise<boolean> {
  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      if (input.release.length > 0) {
        await tx.releaseVersionReservation.updateMany({
          where: { repositoryFullName: input.repositoryFullName, candidateId: input.candidateId, version: { in: input.release }, status: "reserved" },
          data: { status: "released", releasedAt: now },
        });
      }
      const existing = await tx.releaseVersionReservation.findUnique({
        where: { repositoryFullName_version: { repositoryFullName: input.repositoryFullName, version: input.version } },
      });
      if (!existing) {
        await tx.releaseVersionReservation.create({
          data: { repositoryFullName: input.repositoryFullName, version: input.version, candidateId: input.candidateId, status: "reserved" },
        });
        return;
      }
      if (existing.status === "reserved" && existing.candidateId === input.candidateId) return;
      // 手放した版だけ取り直せる。消費済み・他の候補が保持中の版は取らない
      const taken = await tx.releaseVersionReservation.updateMany({
        where: { id: existing.id, status: "released" },
        data: { status: "reserved", candidateId: input.candidateId, releasedAt: null },
      });
      if (taken.count !== 1) throw new Error("version_not_available");
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error) || (error instanceof Error && error.message === "version_not_available")) return false;
    throw error;
  }
}

/** 未公開の予約を手放す（公開前に中止した候補）。タグ・main上に版があれば消費済みにする */
export async function settleReservationsOnCancel(ctx: Context, candidateId: string): Promise<void> {
  const rows = await db.releaseVersionReservation.findMany({ where: { candidateId, status: "reserved" } });
  if (rows.length === 0) return;
  const [tags, mainSha] = await Promise.all([repoTags(ctx), fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null)]);
  const caller = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  const mainVersion =
    caller.supported && mainSha
      ? readVersionFromText(await fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, mainSha, ctx.token).catch(() => null), caller.versionQuery)
      : null;
  for (const row of rows) {
    const verdict = decideReservationRelease({ status: "reserved", version: row.version, existingTags: tags, mainVersion });
    if (verdict === "keep") continue;
    await db.releaseVersionReservation.updateMany({
      where: { id: row.id, status: "reserved" },
      data: verdict === "consume" ? { status: "consumed", consumedAt: new Date() } : { status: "released", releasedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// 要求

export type FinalizeMutationError =
  | keyof typeof FINALIZE_START_ERROR_LABEL
  | "not_found"
  | "caller_unsupported"
  | "invalid_bump_kind"
  | "version_conflict"
  | "dispatch_failed";

export type FinalizeMutationResult =
  | { ok: true; finalizationId: string; existing: boolean }
  | { ok: false; error: FinalizeMutationError; message?: string };

async function existingByRequestKey(requestKey: string): Promise<FinalizeMutationResult | null> {
  const row = await db.releaseCandidateFinalization.findUnique({ where: { requestKey } });
  return row ? { ok: true, finalizationId: row.id, existing: true } : null;
}

async function expireStale(candidateId: string, now: Date): Promise<void> {
  const rows = await db.releaseCandidateFinalization.findMany({ where: { candidateId, status: "requested" } });
  for (const row of rows.filter((r) => isFinalizePendingExpired(r, now))) {
    await failFinalization(row, "workflowの結果を期限内に受け取れませんでした", null, "expired");
  }
}

/**
 * 公開準備（正式バンプ）を始める。**押した時点の候補の先端・mainの先端・合格した契約が全て一致するときだけ**。
 * 上げ幅は手動指定（`bumpKind`）か自動判定（null）。手動指定は要求の時点で版を予約し、自動判定は
 * workflowが判定してバンプしたあと、サーバーが版を取り直して予約する
 */
export async function requestRcFinalize(
  input: Context & { userId: string | null; candidateId: string; expectedHeadSha: string; bumpKind: BumpKind | null; requestKey: string },
): Promise<FinalizeMutationResult> {
  const ctx: Context = input;
  const existing = await existingByRequestKey(input.requestKey);
  if (existing) return existing;
  if (input.bumpKind !== null && !(BUMP_KINDS as readonly string[]).includes(input.bumpKind)) return { ok: false, error: "invalid_bump_kind" };

  const repositoryFullName = fullNameOf(ctx);
  const caller = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  if (!caller.supported) return { ok: false, error: "caller_unsupported" };

  const overview = await loadRcOverview(ctx);
  const candidate = overview.candidate;
  if (!candidate || candidate.id !== input.candidateId) return { ok: false, error: "not_found" };
  await expireStale(candidate.id, new Date());
  const pending = await db.releaseCandidateFinalization.findFirst({ where: { candidateId: candidate.id, status: "requested" } });

  const [pr, mainSha] = await Promise.all([
    observeCandidatePullRequest(ctx, candidate.sequence).catch(() => null),
    fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null),
  ]);
  const decision: FinalizeStartDecision = decideFinalizeStart({
    contract: candidate.finalizeContract,
    phase: candidate.phase,
    observed: pr && pr.base ? { prHeadSha: pr.head.sha, prBaseSha: pr.base.sha, mainSha } : null,
    hasPending: pending !== null,
    expectedHeadSha: input.expectedHeadSha,
  });
  if (!decision.ok) return { ok: false, error: decision.error };
  const contract = decision.contract;

  // 版の予約。起点は常にmainの版（developの版は見ない）
  const [tags, reservations, versionText] = await Promise.all([
    repoTags(ctx),
    loadReservations(repositoryFullName),
    fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, mainSha!, ctx.token).catch(() => null),
  ]);
  const mainVersion = readVersionFromText(versionText, caller.versionQuery);
  let reservedVersion: string | null = null;
  // 自動判定のときも、この候補が既に予約している版があれば渡す（既にその版でバンプ済みなら、workflowは版を増やさない）
  const ownReserved = reservations.find((r) => r.status === "reserved" && r.candidateId === candidate.id)?.version ?? null;
  const unavailable = new Set<string>(tags.map((t) => t.replace(/^v/, "")));
  for (const r of reservations) if (r.status === "consumed" || (r.status === "reserved" && r.candidateId !== candidate.id)) unavailable.add(r.version);
  if (input.bumpKind !== null) {
    const reservation = decideVersionReservation({ candidateId: candidate.id, mainVersion, bumpKind: input.bumpKind, existingTags: tags, reservations });
    if (reservation.action === "conflict") {
      return { ok: false, error: "version_conflict", message: reservation.reason === "reserved_by_other" ? `v${reservation.version}は他の候補が予約しています` : "mainの版を読めませんでした" };
    }
    reservedVersion = reservation.version;
    if (reservation.action === "reserve") {
      const reserved = await reserveVersion({ repositoryFullName, candidateId: candidate.id, version: reservation.version, release: reservation.release });
      if (!reserved) return { ok: false, error: "version_conflict", message: `v${reservation.version}は予約できませんでした` };
    }
  }

  const finalizationRequestKey = input.requestKey;
  let createdId: string;
  try {
    createdId = await db.$transaction(async (tx) => {
      // 段階を`review`→`preparing`へ条件付きで進める。同時の操作・候補の更新があれば進めずに止める
      const moved = await tx.releaseCandidate.updateMany({ where: { id: candidate.id, phase: "review" }, data: { phase: "preparing" } });
      if (moved.count !== 1) throw new Error("phase_changed");
      const row = await tx.releaseCandidateFinalization.create({
        data: {
          candidateId: candidate.id,
          repositoryFullName,
          revision: contract.revision,
          prNumber: contract.prNumber,
          preBaseSha: contract.baseSha,
          preHeadSha: contract.headSha,
          reservedVersion,
          bumpKind: input.bumpKind,
          bumpKindSource: input.bumpKind === null ? "auto" : "manual",
          status: "requested",
          requestKey: finalizationRequestKey,
          pendingKey: candidate.id,
          diffFiles: [],
          handoffEvidence: [],
          requestedByUserId: input.userId,
        },
      });
      return row.id;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "phase_changed") return { ok: false, error: "wrong_phase" };
    if (!isUniqueConstraintError(error)) throw error;
    return (await existingByRequestKey(finalizationRequestKey)) ?? { ok: false, error: "in_progress" };
  }

  try {
    await dispatchReleaseFinalizeWorkflow(
      ctx.owner,
      ctx.repo,
      ctx.token,
      serializeFinalizeWorkflowRequest({
        candidate: candidate.id,
        sequence: candidate.sequence,
        revision: contract.revision,
        requestKey: finalizationRequestKey,
        baseHeadSha: contract.headSha,
        bumpKind: input.bumpKind ?? "auto",
        version: reservedVersion ?? ownReserved,
        unavailableVersions: [...unavailable],
      }),
    );
  } catch (error) {
    console.error("[release-finalize] dispatch failed", repositoryFullName, error);
    const row = await db.releaseCandidateFinalization.findUnique({ where: { id: createdId } });
    if (row) await failFinalization(row, "リリースworkflowを起動できませんでした", null, "failed");
    return { ok: false, error: "dispatch_failed" };
  }
  return { ok: true, finalizationId: createdId, existing: false };
}

/** 公開準備の失敗。**候補を同じ工程（review）へ戻し、版の予約は保つ**（公開前の再試行だけで版を増やさない） */
async function failFinalization(row: { id: string; candidateId: string }, reason: string, runUrl: string | null, status: "failed" | "expired" | "superseded") {
  const updated = await db.releaseCandidateFinalization.updateMany({
    where: { id: row.id, status: { in: ["requested", "applied"] } },
    data: { status, pendingKey: null, failureReason: reason.slice(0, 2000), ...(runUrl ? { runUrl } : {}) },
  });
  if (updated.count === 0) return;
  const handling = decideFinalizeFailureHandling({ merged: false });
  if (!handling) return;
  // 公開準備中・本番承認待ちのどちらからも、同じ候補の修正工程（review）へ戻す
  for (const from of ["preparing", "awaiting_approval"] as const) {
    if (canTransitionRcPhase(from, handling.returnPhase)) {
      await db.releaseCandidate.updateMany({ where: { id: row.candidateId, phase: from }, data: { phase: handling.returnPhase } });
    }
  }
}

// ---------------------------------------------------------------------------
// workflowの報告・照合

type Observed = {
  pull: PullDetail;
  mainSha: string;
  mainVersion: string | null;
  headVersion: string | null;
  changedFiles: string[];
  fastForward: boolean;
};

async function observeForReport(ctx: Context, candidate: CandidateRow, row: FinalizationRow, caller: Extract<FinalizeCallerSupport, { supported: true }>): Promise<Observed | null> {
  const found = await observeCandidatePullRequest(ctx, candidate.sequence).catch(() => null);
  if (!found || found.state !== "open") return null;
  const [pull, mainSha] = await Promise.all([
    fetchPullRequest(ctx.owner, ctx.repo, found.number, ctx.token),
    fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token),
  ]);
  if (!mainSha) return null;
  const head = pull.head.sha;
  const [fastForward, changedFiles, headText, mainText] = await Promise.all([
    head === row.preHeadSha ? true : isAncestorCommit(ctx.owner, ctx.repo, row.preHeadSha, head, ctx.token),
    head === row.preHeadSha ? Promise.resolve([] as string[]) : fetchCompareChangedFiles(ctx.owner, ctx.repo, row.preHeadSha, head, ctx.token),
    fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, head, ctx.token).catch(() => null),
    fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, mainSha, ctx.token).catch(() => null),
  ]);
  return {
    pull,
    mainSha,
    fastForward,
    changedFiles,
    headVersion: readVersionFromText(headText, caller.versionQuery),
    mainVersion: readVersionFromText(mainText, caller.versionQuery),
  };
}

/** 自動判定のとき、バンプ後の版から上げ幅を逆算する（`decideVersionReservation`が同じ版を返す上げ幅） */
function inferBumpKind(input: { candidateId: string; mainVersion: string | null; headVersion: string | null; tags: string[]; reservations: VersionReservationRow[] }): BumpKind | null {
  if (!input.headVersion) return null;
  for (const bumpKind of ["patch", "minor", "major"] as const) {
    const d = decideVersionReservation({ candidateId: input.candidateId, mainVersion: input.mainVersion, bumpKind, existingTags: input.tags, reservations: input.reservations });
    if ((d.action === "reserve" || d.action === "reuse") && d.version === input.headVersion) return bumpKind;
  }
  return null;
}

/**
 * 未完了の公開準備を、実際の候補ブランチと照合して取り込む。報告と画面の読み込みで同じ判定を使うので、
 * 報告が届かなかった・二重に届いたときも結果は1つになる
 */
async function reconcileRequested(ctx: Context, candidate: CandidateRow, row: FinalizationRow, runUrl: string | null): Promise<"applied" | "failed" | "waiting" | "ignored"> {
  const caller = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  if (!caller.supported) return "waiting";
  const observed = await observeForReport(ctx, candidate, row, caller);
  if (observed === null) return "waiting";
  const repositoryFullName = fullNameOf(ctx);
  const [tags, reservations] = await Promise.all([repoTags(ctx), loadReservations(repositoryFullName)]);

  let bumpKind = (row.bumpKind as BumpKind | null) ?? null;
  let expectedVersion = row.reservedVersion;
  if (expectedVersion === null) {
    bumpKind = inferBumpKind({ candidateId: candidate.id, mainVersion: observed.mainVersion, headVersion: observed.headVersion, tags, reservations });
    if (bumpKind !== null) {
      expectedVersion = decideVersionReservation({ candidateId: candidate.id, mainVersion: observed.mainVersion, bumpKind, existingTags: tags, reservations }).action === "conflict"
        ? null
        : observed.headVersion;
    }
  }
  const decision = decideFinalizeReport({
    row: { status: row.status as FinalizeStatus, preHeadSha: row.preHeadSha },
    expectedVersion,
    rules: { versionFile: caller.versionFile },
    observation: {
      pullRequest: { number: observed.pull.number, baseSha: observed.pull.base.sha ?? "", headSha: observed.pull.head.sha, draft: observed.pull.draft },
      fastForward: observed.fastForward,
      changedFiles: observed.changedFiles,
      headVersion: observed.headVersion,
      mainVersion: observed.mainVersion,
    },
  });
  if (decision.action === "ignore") return "ignored";
  if (decision.action === "wait") return "waiting";
  if (decision.action === "fail") {
    await failFinalization(row, decision.reason, runUrl, "failed");
    return "failed";
  }

  // 自動判定の版をここで予約する（手動指定は要求の時点で予約済み）。取れなければバンプを適用しない
  if (row.reservedVersion === null) {
    const reservation = decideVersionReservation({ candidateId: candidate.id, mainVersion: observed.mainVersion, bumpKind: bumpKind!, existingTags: tags, reservations });
    if (reservation.action === "conflict") {
      await failFinalization(row, `版 v${decision.version} を予約できませんでした（他の候補が予約しています）`, runUrl, "failed");
      return "failed";
    }
    if (reservation.action === "reserve" && !(await reserveVersion({ repositoryFullName, candidateId: candidate.id, version: reservation.version, release: reservation.release }))) {
      await failFinalization(row, `版 v${decision.version} を予約できませんでした（他の候補が先に予約しました）`, runUrl, "failed");
      return "failed";
    }
  }

  // 引継ぎの判定。元の結果（バンプ前のSHA）は書き換えず、証跡へ根拠を残す
  const originals = await listReleaseVerificationRecords(repositoryFullName, row.prNumber);
  const config = getReleaseVerificationConfig(repositoryFullName);
  const macRows = await listReleaseMacRows(repositoryFullName, row.prNumber).catch(() => []);
  const requireFreshIos = config.macBuildCheck === true || macRows.some((m) => m.state !== "not_applicable");
  const now = new Date();
  const finalBase = decision.baseSha;
  const evidence: InheritanceEvidence[] = RELEASE_VERIFICATION_KINDS.map((kind) => {
    const before = originals.find((r) => r.kind === kind && r.baseSha === row.preBaseSha && r.headSha === row.preHeadSha) ?? null;
    const noChange = decision.headSha === row.preHeadSha;
    const inherited = decideInheritedVerification({ kind, before, currentBaseSha: finalBase, diff: decision.diff, requireFreshIos });
    // バンプ済みのheadをそのまま使うときは、検証対象も同じSHAなので引継ぎにはしない（元の結果がそのまま現在の対象）
    return buildInheritanceEvidence({
      decision: noChange ? { ...inherited, action: "inherit", reason: "候補は既に予約した版でバンプ済みのため、同じheadの結果をそのまま使います" } : inherited,
      from: { baseSha: row.preBaseSha, headSha: row.preHeadSha },
      to: { baseSha: finalBase, headSha: decision.headSha },
      diff: decision.diff,
      now,
    });
  });

  const applied = await db.$transaction(async (tx) => {
    const updated = await tx.releaseCandidateFinalization.updateMany({
      where: { id: row.id, status: "requested" },
      data: {
        status: "applied",
        pendingKey: null,
        finalBaseSha: finalBase,
        finalHeadSha: decision.headSha,
        reservedVersion: decision.version,
        bumpKind,
        diffFiles: decision.diff.files,
        handoffEvidence: evidence,
        appliedAt: now,
        ...(runUrl ? { runUrl } : {}),
      },
    });
    if (updated.count === 0) return false;
    // バンプ後のheadを候補のrevisionとして記録する（`review`へ戻っても履歴が途切れず、記録に無いpushにならない）
    if (decision.headSha !== row.preHeadSha) {
      const revision = Math.max(...candidate.revisions.map((r) => r.revision)) + 1;
      await tx.releaseCandidateRevision.create({
        data: {
          candidateId: candidate.id,
          revision,
          reason: "finalize_bump",
          status: "applied",
          requestKey: `${row.requestKey}:r`.slice(0, 64),
          expectedHeadSha: row.preHeadSha,
          importedPrs: [],
          prNumber: decision.prNumber,
          baseSha: decision.baseSha,
          headSha: decision.headSha,
          runUrl,
          appliedAt: now,
        },
      });
      await tx.releaseCandidate.updateMany({ where: { id: candidate.id, currentRevision: { lt: revision } }, data: { currentRevision: revision } });
    }
    return true;
  });
  if (!applied) return "ignored";

  // 引き継がなかった種別だけを、バンプ後のheadで再実行する（引き継いだ種別の行は作らない）
  const rerun = evidence.filter((e) => e.action === "rerun" && e.kind !== "ios").map((e) => e.kind as ReleaseVerificationKind);
  if (rerun.length > 0 && decision.headSha !== row.preHeadSha) {
    const target: ReleaseVerificationTarget = { repoFullName: repositoryFullName, prNumber: decision.prNumber, baseSha: finalBase, headSha: decision.headSha };
    try {
      await registerReleaseVerification(target, rerun);
      if (rerun.includes("integration")) await requestReleaseVerifyJob(target);
      if (rerun.includes("ai_review")) await requestReleaseReviewJob(target);
    } catch (error) {
      // 依頼に失敗しても適用の記録は戻さない（画面は「未実施」として出し、再実行で依頼できる）
      console.error("[release-finalize] verification request failed", repositoryFullName, error);
    }
  }
  return "applied";
}

export type FinalizeReportResult =
  | { ok: true; outcome: "applied" | "failed" | "ignored" | "waiting" }
  | { ok: false; reason: "unknown_repository" | "unknown_request" };

/** workflowからの報告（`POST /api/dispatch/release-finalize`）。信じるのは要求キーと結果の種別だけ */
export async function recordFinalizeReport(input: {
  repositoryFullName: string;
  requestKey: string;
  outcome: "applied" | "failed";
  runId: number | null;
  reason: string | null;
}): Promise<FinalizeReportResult> {
  const repository = await db.repository.findFirst({ where: { fullName: input.repositoryFullName }, include: { installation: true } });
  if (!repository) return { ok: false, reason: "unknown_repository" };
  const row = await db.releaseCandidateFinalization.findUnique({ where: { requestKey: input.requestKey } });
  if (!row || row.repositoryFullName !== input.repositoryFullName) return { ok: false, reason: "unknown_request" };
  const runUrl = input.runId !== null ? `https://github.com/${input.repositoryFullName}/actions/runs/${input.runId}` : null;
  if (row.status !== "requested") return { ok: true, outcome: "ignored" };
  if (input.outcome === "failed") {
    await failFinalization(row, input.reason?.trim() || "リリースworkflowが公開準備に失敗しました", runUrl, "failed");
    return { ok: true, outcome: "failed" };
  }
  const candidate = await loadCandidateRow({ id: row.candidateId });
  if (!candidate) return { ok: false, reason: "unknown_request" };
  const token = await getInstallationToken(repository.installation.installationId);
  const ctx: Context = { owner: repository.ownerLogin, repo: repository.name, token };
  return { ok: true, outcome: await reconcileRequested(ctx, candidate, row, runUrl) };
}

// ---------------------------------------------------------------------------
// 公開準備の完了判定・マージ後の追跡

/** 最終検証の状態。バンプ後のheadでCIが成功し、再実行が必要な検証が全て合格したときだけ完了 */
async function evaluateChecks(ctx: Context, row: FinalizationRow, pull: PullDetail): Promise<RcFinalizationChecks> {
  const repositoryFullName = fullNameOf(ctx);
  const [ci, records] = await Promise.all([
    fetchPullRequestCiState(ctx.owner, ctx.repo, pull.number, ctx.token).catch(() => null),
    listReleaseVerificationRecords(repositoryFullName, row.prNumber),
  ]);
  const gate = evaluateReleaseMergeGate({ current: { baseSha: row.finalBaseSha ?? "", headSha: row.finalHeadSha ?? "" }, records, enforced: true });
  const pendingReverify = gate.views.filter((v) => v.state !== "passed" && v.state !== "not_applicable").map((v) => v.kind as FinalizeVerificationKind);
  const ciState = ci?.ciState ?? "unknown";
  const readiness = decideFinalizeReadiness({ checks: { ciState, draft: pull.draft }, pendingReverify });
  return {
    ciState,
    draft: pull.draft,
    pendingReverify,
    readiness,
    readinessLabel: readiness.ready ? null : FINALIZE_READINESS_LABEL[readiness.reason],
  };
}

async function setPhase(candidateId: string, from: RcPhase, to: RcPhase, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (!canTransitionRcPhase(from, to)) return false;
  const updated = await db.releaseCandidate.updateMany({ where: { id: candidateId, phase: from }, data: { phase: to, ...extra } });
  return updated.count === 1;
}

/** mainへ入った版を消費済みにする。**以後再利用せず、変更内容の違う再公開もしない** */
async function consumeReservation(candidateId: string, version: string, mergeSha: string | null, tag: string | null): Promise<void> {
  await db.releaseVersionReservation.updateMany({
    where: { candidateId, version, status: "reserved" },
    data: { status: "consumed", consumedAt: new Date(), consumedMergeSha: mergeSha, consumedTag: tag },
  });
}

/**
 * 公開準備中・本番反映中の候補を1巡進める。画面の読み込み・報告・巡回のどこから呼んでも、
 * 条件付き更新（段階・状態）で同じ結果になる（二重に進めない）
 */
export async function reconcileRcFinalization(ctx: Context, candidateId: string): Promise<void> {
  const candidate = await loadCandidateRow({ id: candidateId });
  if (!candidate) return;
  const phase = parseRcPhase(candidate.phase);
  if (phase === null) return;
  const rows = await loadFinalizationRows(candidate.id);
  const requested = rows.find((r) => r.status === "requested");
  if (requested) {
    if (isFinalizePendingExpired(requested, new Date())) await failFinalization(requested, "workflowの結果を期限内に受け取れませんでした", null, "expired");
    else await reconcileRequested(ctx, candidate, requested, null).catch((error: unknown) => console.error("[release-finalize] reconcile failed", error));
    return;
  }
  // 修正工程（review）・完了・取消では、公開準備の進行は無い（GitHubへ問い合わせない）
  if (!["preparing", "awaiting_approval", "deploying", "verifying_production"].includes(phase)) return;
  const current = [...rows].reverse().find((r) => r.status === "applied");
  if (!current || current.finalHeadSha === null || current.finalBaseSha === null || current.reservedVersion === null) return;

  const found = await observeCandidatePullRequest(ctx, candidate.sequence).catch(() => null);
  if (!found) return;
  const pull = await fetchPullRequest(ctx.owner, ctx.repo, found.number, ctx.token);

  if (phase === "preparing" || phase === "awaiting_approval") {
    if (pull.merged) {
      // 記録した最終headのままマージされたときだけ、本番反映の追跡へ進める
      if (pull.head.sha !== current.finalHeadSha) return;
      if (phase === "preparing") await setPhase(candidate.id, "preparing", "awaiting_approval");
      if (await setPhase(candidate.id, "awaiting_approval", "deploying")) {
        await consumeReservation(candidate.id, current.reservedVersion, (pull as { merge_commit_sha?: string | null }).merge_commit_sha ?? null, null);
      }
      return;
    }
    // 候補の更新・mainの前進があれば、バンプ後の検証と承認の鮮度は失効する。同じ候補の修正工程へ戻す（予約は保つ）
    if (pull.head.sha !== current.finalHeadSha) {
      await failFinalization(current, "公開準備の後に候補が更新されたため、最終検証をやり直します", null, "superseded");
      return;
    }
    const mainSha = await fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null);
    if (mainSha && mainSha !== current.finalBaseSha) {
      await failFinalization(current, "公開準備の後にmainが進んだため、検証と承認を取り直します", null, "superseded");
      return;
    }
    if (pull.draft) {
      const nodeId = (pull as { node_id?: string }).node_id;
      if (nodeId) await markPullRequestReadyForReview(nodeId, ctx.token).catch((error: unknown) => console.error("[release-finalize] ready化に失敗", error));
    }
    const checks = await evaluateChecks(ctx, current, pull);
    if (checks.ciState === "failure" || checks.pendingReverify.length > 0 && (await reverifyFailed(ctx, current))) {
      await failFinalization(current, "バンプ後の最終検証が失敗したため、同じ候補の修正工程へ戻します", null, "failed");
      return;
    }
    if (phase === "preparing" && checks.readiness.ready) await setPhase(candidate.id, "preparing", "awaiting_approval");
    return;
  }

  if (phase === "deploying" || phase === "verifying_production") await advanceProduction(ctx, candidate, current, pull);
}

async function reverifyFailed(ctx: Context, row: FinalizationRow): Promise<boolean> {
  const records = await listReleaseVerificationRecords(fullNameOf(ctx), row.prNumber);
  const gate = evaluateReleaseMergeGate({ current: { baseSha: row.finalBaseSha ?? "", headSha: row.finalHeadSha ?? "" }, records, enforced: true });
  return gate.views.some((v) => v.state === "failed");
}

/**
 * マージ後の追跡。deployの成功**と稼働中の版の一致**を確かめるまで完了にしない（マージだけで完了にしない）。
 * 失敗・不一致は段階を進めず、既存の本番復旧（#4451）が同じ系列として追う
 */
async function advanceProduction(ctx: Context, candidate: CandidateRow, row: FinalizationRow, pull: PullDetail): Promise<void> {
  const mergeSha = (pull as { merge_commit_sha?: string | null }).merge_commit_sha ?? null;
  if (!pull.merged || !mergeSha || !pull.merged_at || row.reservedVersion === null) return;
  // 公開した版をdevelopへ同期する（新方式のバンプはdevelopへ入らないため。完了とは独立に再試行する）
  await ensureDevelopSync(ctx, { version: row.reservedVersion, mergeSha });
  const runs = await fetchDeployRunsForSha(ctx.owner, ctx.repo, mergeSha, ctx.token);
  const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
  const versionVerified = latest?.status === "completed" && latest.conclusion === "success" ? await hasVersionVerification(ctx.owner, ctx.repo, latest, ctx.token) : false;
  const decision: DeployRecoveryReleaseDecision = decideDeployRecoveryRelease(
    { releaseSha: mergeSha, releaseStartedAt: new Date(pull.merged_at), releaseAttempts: 0, lastFailureKey: null },
    { now: new Date(), runs, versionVerified },
  );
  if (decision.action === "track" && decision.status === "verifying") {
    await setPhase(candidate.id, "deploying", "verifying_production");
    return;
  }
  if (decision.action === "recovered") {
    await setPhase(candidate.id, "deploying", "verifying_production");
    const tag = (await repoTags(ctx)).find((t) => t === `v${row.reservedVersion}`) ?? null;
    if (await setPhase(candidate.id, "verifying_production", "completed", { activeKey: null })) {
      await consumeReservation(candidate.id, row.reservedVersion, mergeSha, tag);
      await db.releaseVersionReservation.updateMany({ where: { candidateId: candidate.id, version: row.reservedVersion, status: "consumed", consumedTag: null }, data: { consumedTag: tag } });
    }
  }
}

// ---------------------------------------------------------------------------
// 公開後のdevelopとの整合

/**
 * 公開した版（mainのバンプ）をdevelopへ同期する。**新方式ではバンプがdevelopへ入らないまま公開される**ので、
 * 同期しないと次の候補のバンプがmainの版と衝突し、developの古い版を「バンプ済み」と誤判定する原因になる。
 * mainをdevelopへマージするPRを作る（develop向けの通常のPRとして、既存のCI・レビュー・自動マージを通る）。
 * 既に反映済み・同期PRが開いていれば何もしない。失敗しても本番反映の追跡は止めない（次の巡回で再試行する）
 */
export async function ensureDevelopSync(ctx: Context, input: { version: string; mergeSha: string }): Promise<"synced" | "pending" | "created" | "failed"> {
  try {
    const developSha = await fetchBranchHeadSha(ctx.owner, ctx.repo, "develop", ctx.token);
    if (!developSha) return "failed";
    if (await isAncestorCommit(ctx.owner, ctx.repo, input.mergeSha, developSha, ctx.token)) return "synced";
    const open = await fetchOpenPullRequestsForBase(ctx.owner, ctx.repo, "develop", ctx.token);
    if (open.some((pr) => pr.head.ref === "main")) return "pending";
    await createPullRequest(ctx.owner, ctx.repo, ctx.token, {
      title: `v${input.version}の公開をdevelopへ同期する`,
      base: "develop",
      head: "main",
      body: [
        `v${input.version} をmainへ公開したため、バージョンと更新履歴の変更をdevelopへ取り込みます（#4496）。`,
        "",
        "- 新方式のリリース候補は、公開準備で候補ブランチにだけバンプを積み、developへは入れません。同期しないと、次の候補のバンプがmainの版と衝突します",
        "- このPRのマージ後に、次のリリース候補を作れます（それまでは作成を断ります）",
        "",
        `<!-- issue-deck-develop-sync:v${input.version} -->`,
      ].join("\n"),
    });
    return "created";
  } catch (error) {
    console.error("[release-finalize] develop sync failed", fullNameOf(ctx), error);
    return "failed";
  }
}

/** 公開した版がdevelopへ反映されていない間は、次の候補を作らない（古い版のdevelopから作ると、mainの版と衝突する） */
export async function findUnsyncedPublish(ctx: Context): Promise<{ version: string; mergeSha: string } | null> {
  const consumed = await db.releaseVersionReservation.findMany({
    where: { repositoryFullName: fullNameOf(ctx), status: "consumed", consumedMergeSha: { not: null } },
    orderBy: { consumedAt: "desc" },
    take: 1,
  });
  const latest = consumed[0];
  if (!latest?.consumedMergeSha) return null;
  const developSha = await fetchBranchHeadSha(ctx.owner, ctx.repo, "develop", ctx.token).catch(() => null);
  if (!developSha) return null;
  const synced = await isAncestorCommit(ctx.owner, ctx.repo, latest.consumedMergeSha, developSha, ctx.token).catch(() => true);
  return synced ? null : { version: latest.version, mergeSha: latest.consumedMergeSha };
}

// ---------------------------------------------------------------------------
// 画面向けの取得

/** 候補の公開準備の状況（画面用）。`reconcile`なら、公開準備・本番反映の進行を先に1巡進める */
export async function loadFinalizationOverview(ctx: Context, candidateId: string | null, options: { reconcile?: boolean } = {}): Promise<RcFinalizationOverview> {
  const support = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  const caller = { ...support, reasonLabel: support.supported ? null : ({ caller_unreadable: "リリースworkflowのcallerを読めません", caller_without_input: "このリポジトリのリリースworkflowは公開準備（finalize_request）に未対応です。共有workflowの参照タグとcallerを対応版へ上げると始められます" } as const)[support.reason] };
  const empty: RcFinalizationOverview = { caller, mainVersion: null, current: null, checks: null, history: [] };
  if (candidateId === null) return empty;

  if (options.reconcile !== false) {
    await reconcileRcFinalization(ctx, candidateId).catch((error: unknown) => console.error("[release-finalize] reconcile failed", fullNameOf(ctx), error));
  }
  const rows = await loadFinalizationRows(candidateId);
  const reservations = await db.releaseVersionReservation.findMany({ where: { candidateId } });
  const viewOf = (row: FinalizationRow) => toView(row, reservations.find((r) => r.version === row.reservedVersion) ?? null);
  const latest = rows[rows.length - 1] ?? null;
  const candidate = await loadCandidateRow({ id: candidateId });

  let checks: RcFinalizationChecks | null = null;
  let mainVersion: string | null = null;
  if (support.supported) {
    const mainSha = await fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null);
    if (mainSha) mainVersion = readVersionFromText(await fetchFileTextAtRef(ctx.owner, ctx.repo, support.versionFile, mainSha, ctx.token).catch(() => null), support.versionQuery);
  }
  if (latest && latest.status === "applied" && candidate && ["preparing", "awaiting_approval"].includes(candidate.phase)) {
    const found = await observeCandidatePullRequest(ctx, candidate.sequence).catch(() => null);
    if (found) checks = await evaluateChecks(ctx, latest, await fetchPullRequest(ctx.owner, ctx.repo, found.number, ctx.token)).catch(() => null);
  }
  return { caller, mainVersion, current: latest ? viewOf(latest) : null, checks, history: rows.slice(0, -1).reverse().map(viewOf) };
}

/** 画面が見ている候補のID。PR番号があればそのPRを持つ候補（過去のものも含む）、無ければ進行中の候補（GitHubは呼ばない） */
export async function resolveRcCandidateId(repositoryFullName: string, pullRequestNumber?: number): Promise<string | null> {
  if (pullRequestNumber !== undefined) {
    const revision = await db.releaseCandidateRevision.findFirst({
      where: { prNumber: pullRequestNumber, candidate: { repositoryFullName } },
      select: { candidateId: true },
    });
    return revision?.candidateId ?? null;
  }
  const row = await db.releaseCandidate.findUnique({ where: { activeKey: repositoryFullName }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * リリース完了系列（#4480）へ渡す、新方式の候補の公開準備の観測。旧方式の候補・記録の無い候補はnull。
 * 候補のPR番号は、公開準備のバンプ後も同じ（物理PRは変わらずheadだけが進む）
 */
export async function loadFinalizationSnapshot(
  repositoryFullName: string,
  prNumber: number,
): Promise<{ candidateId: string; phase: string; applied: { preHeadSha: string; finalHeadSha: string; finalBaseSha: string } | null } | null> {
  const revision = await db.releaseCandidateRevision.findFirst({
    where: { prNumber, candidate: { repositoryFullName } },
    select: { candidate: { select: { id: true, phase: true } } },
  });
  if (!revision) return null;
  // バンプ前→バンプ後の対応は、その後に最終検証が失敗して修正工程へ戻った公開準備でも事実として残る。
  // 完了系列が追いかけ損ねて止まらないよう、最終headが記録された最新の行を使う（公開できるかは段階で別に判定する）
  const latest = await db.releaseCandidateFinalization.findFirst({
    where: { candidateId: revision.candidate.id, finalHeadSha: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  return {
    candidateId: revision.candidate.id,
    phase: revision.candidate.phase,
    applied:
      latest && latest.finalHeadSha && latest.finalBaseSha
        ? { preHeadSha: latest.preHeadSha, finalHeadSha: latest.finalHeadSha, finalBaseSha: latest.finalBaseSha }
        : null,
  };
}
