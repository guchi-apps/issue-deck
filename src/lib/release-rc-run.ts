import { db } from "@/lib/db";
import { requestReleaseReviewJob } from "@/lib/dispatch/release-review-jobs";
import { requestReleaseVerifyJob } from "@/lib/dispatch/release-verify-jobs";
import { closePullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createComment } from "@/lib/github/issues-api";
import {
  dispatchReleaseCandidateWorkflow,
  fetchBranchHeadSha,
  fetchCommitSummary,
  fetchFileTextAtRef,
  fetchMainHeadSha,
  fetchOpenPullRequestsForBase,
  fetchPullRequestForRebuild,
  fetchPullRequestsByHead,
  fetchReleaseCallerText,
  fetchReleaseRebuildCandidate,
  isAncestorCommit,
} from "@/lib/github/release-api";
import { parseFinalizeCallerSupport, readVersionFromText } from "@/lib/release-finalize";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { isLegacyReleaseCandidateHeadRef, legacyReleaseVersionOf, rcBranchName } from "@/lib/release-branch";
import { developSyncCreateError } from "@/lib/release-develop-sync";
import { ensureDevelopSync } from "@/lib/release-develop-sync-run";
import { isReleaseFixActive } from "@/lib/release-fix-series";
import { evaluateReleaseMergeGate } from "@/lib/release-merge-gate";
import {
  buildRcFinalizeContract,
  canCancelRc,
  decideLegacyMigration,
  decideRcImport,
  decideRcReport,
  deriveRcStatus,
  isRcRevisionPendingExpired,
  LEGACY_MIGRATION_PROBLEM_LABEL,
  classifyRcBlock,
  parseRcCallerSupport,
  parseRcPhase,
  RC_CALLER_REASON_LABEL,
  RC_REVISION_REASON_LABEL,
  rcLabel,
  serializeRcWorkflowRequest,
  type RcBlockSummary,
  type RcCallerSupport,
  type RcFinalizeContract,
  type RcPullRequestObservation,
  type RcRevisionReason,
  type RcRevisionStatus,
  type RcStatusView,
} from "@/lib/release-rc";
import { checkRebuildPullRequest, orderSelection, REBUILD_PR_PROBLEM_LABEL, type RebuildPullRequestProblem } from "@/lib/release-rebuild-selection";
import { listReleaseVerificationRecords, registerReleaseVerification } from "@/lib/release-verification";

/**
 * 正式版を上げる前に固定したリリース候補（#4495）の外部操作。判断は`release-rc.ts`の純関数が持つ。
 *
 * - **作成・更新は要求キーで冪等にする。** 同じ要求の再送・二重押しは既存の候補・revisionを返す。
 *   同じリポジトリの候補は`activeKey`で1本、同じ候補への更新は`pendingKey`で1本に絞る
 * - workflowの報告は信じず、候補ブランチのPR・SHAをGitHubから取り直して`decideRcReport`で照合する。
 *   報告が届かなかった（再起動・通信断）ときも、画面の読み込みで同じ照合をして取り込む
 * - 更新に失敗しても候補の`currentRevision`は進めない。元のrevision・選択内容・承認は残る
 * - 検証は既存の統合検証・全体レビュー（`ReleaseVerification`。対象はPR番号＋base/head SHA）をそのまま使う。
 *   revisionが変わればheadが変わるので、旧revisionの結果は現在の合格にならない
 * - 旧方式（`release-main/v*`）の候補は閉じず、バンプも取り消さない。移行は明示的な操作だけで行う
 */

export type Context = { owner: string; repo: string; token: string };

const fullNameOf = (ctx: Context) => `${ctx.owner}/${ctx.repo}`;

type FrozenPr = { number: number; title: string; mergeSha: string };
type ImportedPr = { number: number; title: string; mergeSha: string; related: boolean };
type ApprovedExtra = { number: number; mergeSha: string; approvedByUserId: string | null; approvedAt: string; reason: string | null };

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export type RcRevisionView = {
  revision: number;
  reason: RcRevisionReason;
  reasonLabel: string;
  status: RcRevisionStatus;
  importedPrs: ImportedPr[];
  prNumber: number | null;
  baseSha: string | null;
  headSha: string | null;
  runUrl: string | null;
  failureReason: string | null;
  fixSeriesId: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type RcCandidateView = {
  id: string;
  sequence: number;
  label: string;
  branch: string;
  phase: string;
  status: RcStatusView;
  frozenDevelopSha: string;
  frozenPrs: FrozenPr[];
  approvedExtraPrs: ApprovedExtra[];
  currentRevision: number;
  /** 現在の物理PR（適用済みの最新revisionのもの） */
  prNumber: number | null;
  revisions: RcRevisionView[];
  migratedFromPrNumber: number | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** 公開準備（#4496）へ渡す契約。現在revisionが合格しているときだけ */
  finalizeContract: RcFinalizeContract | null;
};

export type RcLegacyCandidate = {
  prNumber: number;
  version: string | null;
  headSha: string;
  /** 新方式へ移行できるか。できなければ理由（旧方式のまま完了させる） */
  migratable: { ok: true } | { ok: false; reason: string };
};

export type RcOverview = {
  caller: RcCallerSupport & { reasonLabel: string | null };
  candidate: RcCandidateView | null;
  legacy: RcLegacyCandidate | null;
};

export type CandidateRow = NonNullable<Awaited<ReturnType<typeof loadCandidateRow>>>;

export async function loadCandidateRow(where: { id: string } | { activeKey: string }) {
  return db.releaseCandidate.findUnique({ where, include: { revisions: { orderBy: { revision: "asc" } } } });
}

function toRevisionView(row: CandidateRow["revisions"][number]): RcRevisionView {
  const reason = row.reason as RcRevisionReason;
  return {
    revision: row.revision,
    reason,
    reasonLabel: RC_REVISION_REASON_LABEL[reason] ?? row.reason,
    status: row.status as RcRevisionStatus,
    importedPrs: jsonArray<ImportedPr>(row.importedPrs),
    prNumber: row.prNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    runUrl: row.runUrl,
    failureReason: row.failureReason,
    fixSeriesId: row.fixSeriesId,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}

export async function callerSupport(ctx: Context): Promise<RcCallerSupport> {
  return parseRcCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
}

/** 候補ブランチをheadとするmain向けのPR（新しい順の先頭）。PRを作り直していても同じブランチなら追える */
export async function observeCandidatePullRequest(ctx: Context, sequence: number) {
  const prs = await fetchPullRequestsByHead(ctx.owner, ctx.repo, rcBranchName(sequence), "main", ctx.token);
  return prs.find((pr) => pr.state === "open") ?? prs[0] ?? null;
}

/** 結果を受け取れないまま期限を過ぎた更新要求を失効させる（同じ候補へやり直せるように） */
async function expireStalePending(row: CandidateRow, now: Date): Promise<boolean> {
  const stale = row.revisions.filter((r) => isRcRevisionPendingExpired(r, now));
  if (stale.length === 0) return false;
  await db.releaseCandidateRevision.updateMany({
    where: { id: { in: stale.map((r) => r.id) }, status: "requested" },
    data: { status: "expired", pendingKey: null, failureReason: "workflowの結果を期限内に受け取れませんでした" },
  });
  // 初回の作成が届かなかった候補は、同じリポジトリで作り直せるよう解放する（記録は残す）
  if (row.currentRevision === 0) {
    await db.releaseCandidate.updateMany({
      where: { id: row.id, phase: "creating" },
      data: { phase: "cancelled", activeKey: null, cancelReason: "候補の作成結果を期限内に受け取れませんでした", cancelledAt: now },
    });
  }
  return true;
}

/**
 * 未完了の更新要求を、実際の候補ブランチと照合して取り込む。報告と同じ判定（`decideRcReport`）を使うので、
 * 報告が届かなかった・二重に届いたときも結果は1つになる
 */
async function reconcileRevision(input: {
  ctx: Context;
  candidate: CandidateRow;
  revisionId: string;
  runUrl?: string | null;
}): Promise<"applied" | "failed" | "ignored" | "waiting"> {
  const { ctx, candidate } = input;
  const row = candidate.revisions.find((r) => r.id === input.revisionId);
  if (!row) return "ignored";
  const pr = await observeCandidatePullRequest(ctx, candidate.sequence);
  if (pr === null || pr.state !== "open") return "waiting";
  const from = row.expectedHeadSha ?? candidate.frozenDevelopSha;
  const fastForward = pr.head.sha === from ? true : await isAncestorCommit(ctx.owner, ctx.repo, from, pr.head.sha, ctx.token);
  const decision = decideRcReport({
    row: { status: row.status as RcRevisionStatus, revision: row.revision, expectedHeadSha: row.expectedHeadSha, reason: row.reason as RcRevisionReason },
    frozenDevelopSha: candidate.frozenDevelopSha,
    observation: { pullRequest: { number: pr.number, baseSha: pr.base.sha, headSha: pr.head.sha, headRef: pr.head.ref }, fastForward },
  });
  if (decision.action === "ignore") return "ignored";
  if (decision.action === "fail") {
    // 未更新（まだpushされていない）だけは待つ。それ以外の食い違いは失敗として残す
    if (row.expectedHeadSha !== null && pr.head.sha === row.expectedHeadSha && !input.runUrl) return "waiting";
    await failRevision(candidate, row.id, decision.reason, input.runUrl ?? null);
    return "failed";
  }
  const applied = await db.$transaction(async (tx) => {
    const updated = await tx.releaseCandidateRevision.updateMany({
      where: { id: row.id, status: "requested" },
      data: {
        status: "applied",
        pendingKey: null,
        prNumber: decision.prNumber,
        baseSha: decision.baseSha,
        headSha: decision.headSha,
        appliedAt: new Date(),
        ...(input.runUrl ? { runUrl: input.runUrl } : {}),
      },
    });
    if (updated.count === 0) return false;
    await tx.releaseCandidate.updateMany({
      where: { id: candidate.id, currentRevision: { lt: row.revision } },
      data: { currentRevision: row.revision },
    });
    await tx.releaseCandidate.updateMany({ where: { id: candidate.id, phase: "creating" }, data: { phase: "review" } });
    return true;
  });
  if (!applied) return "ignored";

  // 新しいrevisionのSHAで全体レビュー・統合検証を依頼する（既存の仕組み。同じ対象は重複しない）
  const target = { repoFullName: fullNameOf(ctx), prNumber: decision.prNumber, baseSha: decision.baseSha, headSha: decision.headSha };
  try {
    await registerReleaseVerification(target);
    await requestReleaseVerifyJob(target);
    await requestReleaseReviewJob(target);
  } catch (error) {
    // 依頼に失敗しても適用の記録は戻さない（画面は「未実施」として出し、再実行で依頼できる）
    console.error("[release-rc] verification request failed", fullNameOf(ctx), error);
  }

  // 旧方式から移行した候補は、後継を作れた後にだけ旧PRを閉じる（バンプは取り消さない）
  if (row.reason === "migration" && candidate.migratedFromPrNumber !== null) {
    await closeLegacyAfterMigration(ctx, candidate.migratedFromPrNumber, candidate.sequence, decision.prNumber).catch((error) => {
      console.error("[release-rc] closing legacy candidate failed", fullNameOf(ctx), error);
    });
  }
  return "applied";
}

async function failRevision(candidate: CandidateRow, revisionId: string, reason: string, runUrl: string | null): Promise<void> {
  const now = new Date();
  await db.releaseCandidateRevision.updateMany({
    where: { id: revisionId, status: "requested" },
    data: { status: "failed", pendingKey: null, failureReason: reason.slice(0, 2000), ...(runUrl ? { runUrl } : {}) },
  });
  if (candidate.currentRevision === 0) {
    await db.releaseCandidate.updateMany({
      where: { id: candidate.id, phase: "creating" },
      data: { phase: "cancelled", activeKey: null, cancelReason: `候補を作成できませんでした: ${reason}`.slice(0, 2000), cancelledAt: now },
    });
  }
}

async function closeLegacyAfterMigration(ctx: Context, legacyPrNumber: number, sequence: number, newPrNumber: number) {
  await createComment(ctx.owner, ctx.repo, legacyPrNumber, ctx.token, {
    body: [
      `この候補は新方式のリリース候補 ${rcLabel(sequence)}（#${newPrNumber}）へ移行したため閉じます。`,
      "",
      "- 版上げ（バンプ）のコミットは取り消していません。公開準備で版を確定するときに整合させます",
      "- このPRの検証結果・コメントは記録として残ります（新しい候補の合否には使いません）",
    ].join("\n"),
  });
  await closePullRequest(ctx.owner, ctx.repo, legacyPrNumber, ctx.token);
}

async function relatedFixPrNumbers(repositoryFullName: string, prNumbers: number[]): Promise<{ fixPrs: number[]; active: boolean }> {
  if (prNumbers.length === 0) return { fixPrs: [], active: false };
  const rows = await db.releaseFixSeries.findMany({
    where: { repositoryFullName, OR: [{ releasePrNumber: { in: prNumbers } }, { successorPrNumber: { in: prNumbers } }] },
    select: { fixPrNumber: true, status: true },
  });
  return {
    fixPrs: rows.filter((r) => r.status !== "stopped" && r.status !== "superseded").flatMap((r) => (r.fixPrNumber === null ? [] : [r.fixPrNumber])),
    active: rows.some((r) => isReleaseFixActive(r.status)),
  };
}

async function buildCandidateView(ctx: Context, row: CandidateRow): Promise<RcCandidateView> {
  const phase = parseRcPhase(row.phase) ?? "review";
  const applied = row.revisions.filter((r) => r.status === "applied");
  const current = applied.find((r) => r.revision === row.currentRevision) ?? null;
  const pending = row.revisions.find((r) => r.status === "requested") ?? null;
  const prNumbers = [...new Set(applied.flatMap((r) => (r.prNumber === null ? [] : [r.prNumber])))];

  let pullRequest: RcPullRequestObservation | null = null;
  let gate = null;
  if (current?.prNumber != null) {
    const pr = await observeCandidatePullRequest(ctx, row.sequence).catch(() => null);
    if (pr) {
      pullRequest = { number: pr.number, state: pr.state, merged: pr.merged_at !== null, baseSha: pr.base.sha, headSha: pr.head.sha };
      const records = await listReleaseVerificationRecords(fullNameOf(ctx), pr.number);
      // 状態の判定は常に強制ありで評価する（未合格を合格と見せない）。マージの強制はマージゲート側が持つ
      gate = evaluateReleaseMergeGate({ current: { baseSha: pr.base.sha, headSha: pr.head.sha }, records, enforced: true });
    }
  }
  const fix = await relatedFixPrNumbers(fullNameOf(ctx), prNumbers);
  const status = deriveRcStatus({
    phase,
    current: current ? { revision: current.revision, headSha: current.headSha } : null,
    pending: pending ? { revision: pending.revision, reason: pending.reason as RcRevisionReason } : null,
    pullRequest,
    gate,
    fixInProgress: fix.active,
  });
  const frozenPrs = jsonArray<FrozenPr>(row.frozenPrs);
  const imported = applied.flatMap((r) => jsonArray<ImportedPr>(r.importedPrs).map((p) => p.number));
  return {
    id: row.id,
    sequence: row.sequence,
    label: rcLabel(row.sequence),
    branch: rcBranchName(row.sequence),
    phase,
    status,
    frozenDevelopSha: row.frozenDevelopSha,
    frozenPrs,
    approvedExtraPrs: jsonArray<ApprovedExtra>(row.approvedExtraPrs),
    currentRevision: row.currentRevision,
    prNumber: current?.prNumber ?? null,
    revisions: row.revisions.map(toRevisionView).reverse(),
    migratedFromPrNumber: row.migratedFromPrNumber,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    finalizeContract: buildRcFinalizeContract({
      candidate: { id: row.id, sequence: row.sequence, frozenDevelopSha: row.frozenDevelopSha, frozenPrNumbers: frozenPrs.map((p) => p.number) },
      current: current
        ? { revision: current.revision, prNumber: current.prNumber, baseSha: current.baseSha, headSha: current.headSha, importedPrNumbers: imported }
        : null,
      status: status.status,
    }),
  };
}

async function findLegacyCandidate(ctx: Context): Promise<RcLegacyCandidate | null> {
  const open = await fetchOpenPullRequestsForBase(ctx.owner, ctx.repo, "main", ctx.token);
  const pr = open.find((p) => isLegacyReleaseCandidateHeadRef(p.head.ref));
  if (!pr) return null;
  let migratable: RcLegacyCandidate["migratable"];
  try {
    const decision = decideLegacyMigration(await fetchCommitSummary(ctx.owner, ctx.repo, pr.head.sha, ctx.token));
    migratable = decision.ok ? { ok: true } : { ok: false, reason: LEGACY_MIGRATION_PROBLEM_LABEL[decision.reason] };
  } catch {
    migratable = { ok: false, reason: "候補の先端を取得できませんでした" };
  }
  return { prNumber: pr.number, version: legacyReleaseVersionOf(pr.head.ref), headSha: pr.head.sha, migratable };
}

/** 期限切れの失効と、未完了の更新の照合。状態が変わったらtrue */
async function reconcilePending(ctx: Context, row: CandidateRow): Promise<boolean> {
  const now = new Date();
  let changed = await expireStalePending(row, now);
  const pending = row.revisions.find((r) => r.status === "requested" && !isRcRevisionPendingExpired(r, now));
  if (pending) {
    const result = await reconcileRevision({ ctx, candidate: row, revisionId: pending.id }).catch(() => "waiting" as const);
    changed = changed || result === "applied" || result === "failed";
  }
  return changed;
}

/**
 * PR番号から候補を引く。revisionをまたぐ物理PR（バンプ前後・置換後）は`ReleaseCandidateRevision.prNumber`、
 * 旧方式（`release-main/vX.Y.Z`）から移行した候補の元PRは`migratedFromPrNumber`で同じ候補へ解決する（#4597）
 */
export async function findCandidateIdByPullRequest(repositoryFullName: string, prNumber: number): Promise<string | null> {
  const revision = await db.releaseCandidateRevision.findFirst({
    where: { prNumber, candidate: { repositoryFullName } },
    select: { candidateId: true },
  });
  if (revision) return revision.candidateId;
  const migrated = await db.releaseCandidate.findFirst({
    where: { repositoryFullName, migratedFromPrNumber: prNumber },
    orderBy: { sequence: "desc" },
    select: { id: true },
  });
  return migrated?.id ?? null;
}

/**
 * リポジトリの候補の状況。`pullRequestNumber`を渡すとそのPRを持つ候補（過去のものも含む）、無ければ進行中の候補を返す。
 * 未完了の更新は、ここで実際の候補ブランチと照合して取り込む（報告が届かなかった場合の回復）
 */
export async function loadRcOverview(input: Context & { pullRequestNumber?: number }): Promise<RcOverview> {
  const ctx: Context = input;
  const repositoryFullName = fullNameOf(ctx);
  const support = await callerSupport(ctx);
  const caller = { ...support, reasonLabel: support.supported ? null : RC_CALLER_REASON_LABEL[support.reason] };

  let row: CandidateRow | null = null;
  if (input.pullRequestNumber !== undefined) {
    const candidateId = await findCandidateIdByPullRequest(repositoryFullName, input.pullRequestNumber);
    if (candidateId) row = await loadCandidateRow({ id: candidateId });
  } else {
    row = await loadCandidateRow({ activeKey: repositoryFullName });
  }

  if (row && (await reconcilePending(ctx, row))) row = await loadCandidateRow({ id: row.id });

  return {
    caller,
    candidate: row ? await buildCandidateView(ctx, row) : null,
    legacy: await findLegacyCandidate(ctx).catch(() => null),
  };
}

/**
 * 新しい候補の開始を妨げる既存候補（無ければnull）。開始前の画面と開始直前の判定が同じ結果を使う（#4628）。
 * 未完了の更新は`loadRcOverview`と同じく実際の候補ブランチと照合してから読む
 */
export async function loadRcBlock(ctx: Context): Promise<RcBlockSummary | null> {
  let row = await loadCandidateRow({ activeKey: fullNameOf(ctx) });
  if (!row) return null;
  if (await reconcilePending(ctx, row)) {
    row = await loadCandidateRow({ id: row.id });
    if (!row) return null;
  }
  const candidate = await buildCandidateView(ctx, row);
  const phase = parseRcPhase(row.phase) ?? "review";
  return classifyRcBlock({
    candidateId: row.id,
    sequence: row.sequence,
    prNumber: candidate.prNumber,
    phase,
    status: candidate.status.status,
    statusLabel: candidate.status.label,
  });
}

export type RcMutationError =
  | "caller_unsupported"
  | "rc_active"
  | "legacy_open"
  | "nothing_to_release"
  | "dispatch_failed"
  | "not_found"
  | "not_reviewable"
  | "revision_in_progress"
  | "candidate_changed"
  | "approval_required"
  | "invalid_selection"
  | "empty_selection"
  | "not_cancellable"
  | "not_migratable"
  | "legacy_changed"
  | "develop_not_synced"
  | "develop_sync_unknown";

export type RcMutationResult =
  | { ok: true; candidateId: string; revision: number; existing: boolean }
  | { ok: false; error: RcMutationError; message?: string; block?: RcBlockSummary; unapproved?: number[]; problems?: { number: number; problem: RebuildPullRequestProblem; label: string }[] };

async function existingByRequestKey(requestKey: string): Promise<RcMutationResult | null> {
  const revision = await db.releaseCandidateRevision.findUnique({ where: { requestKey } });
  if (revision) return { ok: true, candidateId: revision.candidateId, revision: revision.revision, existing: true };
  const candidate = await db.releaseCandidate.findUnique({ where: { requestKey } });
  if (candidate) return { ok: true, candidateId: candidate.id, revision: 1, existing: true };
  return null;
}

async function nextSequence(repositoryFullName: string): Promise<number> {
  const last = await db.releaseCandidate.findFirst({ where: { repositoryFullName }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  return (last?.sequence ?? 0) + 1;
}

async function frozenPullRequests(ctx: Context, mainSha: string, freezeSha: string): Promise<FrozenPr[]> {
  const changes = await fetchReleaseRebuildCandidate(ctx.owner, ctx.repo, mainSha, ctx.token, freezeSha);
  return changes.pullRequests.flatMap((pr) => (pr.mergeSha ? [{ number: pr.number, title: pr.title, mergeSha: pr.mergeSha }] : []));
}

/** 候補行と初回revisionを作り、workflowを起動する（作成・移行で共通） */
async function createCandidate(input: {
  ctx: Context;
  userId: string;
  requestKey: string;
  freezeSha: string;
  frozenPrs: FrozenPr[];
  reason: "initial" | "migration";
  migratedFrom?: { prNumber: number; headSha: string };
}): Promise<RcMutationResult> {
  const { ctx } = input;
  const repositoryFullName = fullNameOf(ctx);
  let created: { id: string; sequence: number } | null = null;
  for (let attempt = 0; attempt < 3 && created === null; attempt++) {
    const sequence = await nextSequence(repositoryFullName);
    try {
      created = await db.releaseCandidate.create({
        data: {
          repositoryFullName,
          sequence,
          phase: "creating",
          frozenDevelopSha: input.freezeSha,
          frozenPrs: input.frozenPrs,
          approvedExtraPrs: [],
          activeKey: repositoryFullName,
          requestKey: input.requestKey,
          migratedFromPrNumber: input.migratedFrom?.prNumber ?? null,
          migratedFromHeadSha: input.migratedFrom?.headSha ?? null,
          createdByUserId: input.userId,
          revisions: {
            create: {
              revision: 1,
              reason: input.reason,
              status: "requested",
              requestKey: `${input.requestKey}:1`,
              pendingKey: undefined,
              importedPrs: [],
              requestedByUserId: input.userId,
            },
          },
        },
        select: { id: true, sequence: true },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await existingByRequestKey(input.requestKey);
      if (existing) return existing;
      if (await db.releaseCandidate.findUnique({ where: { activeKey: repositoryFullName } })) return { ok: false, error: "rc_active" };
      // 候補番号の採番が同時に走った。番号を採り直す
    }
  }
  if (created === null) return { ok: false, error: "rc_active" };
  await db.releaseCandidateRevision.updateMany({ where: { candidateId: created.id, revision: 1 }, data: { pendingKey: created.id } });

  try {
    await dispatchReleaseCandidateWorkflow(
      ctx.owner,
      ctx.repo,
      ctx.token,
      serializeRcWorkflowRequest({
        candidate: created.id,
        sequence: created.sequence,
        revision: 1,
        requestKey: `${input.requestKey}:1`,
        baseHeadSha: input.freezeSha,
        mode: "create",
        prs: [],
      }),
    );
  } catch (error) {
    console.error("[release-rc] dispatch failed", repositoryFullName, error);
    const row = await loadCandidateRow({ id: created.id });
    const revision = row?.revisions.find((r) => r.revision === 1);
    if (row && revision) await failRevision(row, revision.id, "リリースworkflowを起動できませんでした", null);
    return { ok: false, error: "dispatch_failed" };
  }
  return { ok: true, candidateId: created.id, revision: 1, existing: false };
}

/**
 * developの現在の先端を固定して候補を作る。**正式版・公開タグ・公開用の更新履歴は作らない。**
 * 旧方式の候補が開いている間は作らない（旧方式のまま完了させるか、明示的に移行する）
 */
export async function createReleaseRc(input: Context & { userId: string; requestKey: string }): Promise<RcMutationResult> {
  const ctx: Context = input;
  const existing = await existingByRequestKey(input.requestKey);
  if (existing) return existing;
  const repositoryFullName = fullNameOf(ctx);
  if (!(await callerSupport(ctx)).supported) return { ok: false, error: "caller_unsupported" };
  const active = await loadCandidateRow({ activeKey: repositoryFullName });
  if (active) {
    await expireStalePending(active, new Date());
    if (await db.releaseCandidate.findUnique({ where: { activeKey: repositoryFullName } })) {
      // 表示後に別の候補ができた場合に、エラー文だけで終えず既存候補と次の操作を返す（#4628）
      return { ok: false, error: "rc_active", block: (await loadRcBlock(ctx).catch(() => null)) ?? undefined };
    }
  }
  const open = await fetchOpenPullRequestsForBase(ctx.owner, ctx.repo, "main", ctx.token);
  if (open.some((pr) => isLegacyReleaseCandidateHeadRef(pr.head.ref))) return { ok: false, error: "legacy_open" };
  // 前回の公開がdevelopへ戻っていることを実際のGit履歴で確かめるまで作らない（#4641）。未同期なら同期PRを用意したうえで断り、
  // 判定できないときも同期済みとはみなさない。API以外の経路から呼ばれても、取消・外部マージの後でも同じ判定を通る
  const syncError = developSyncCreateError(await ensureDevelopSync(ctx));
  if (syncError) return { ok: false, ...syncError };

  const freezeSha = await fetchBranchHeadSha(ctx.owner, ctx.repo, "develop", ctx.token);
  const mainSha = await fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token);
  if (!freezeSha || !mainSha) return { ok: false, error: "nothing_to_release", message: "developまたはmainの先端を取得できませんでした" };
  const frozenPrs = await frozenPullRequests(ctx, mainSha, freezeSha);
  if (frozenPrs.length === 0) return { ok: false, error: "nothing_to_release" };
  return createCandidate({ ctx, userId: input.userId, requestKey: input.requestKey, freezeSha, frozenPrs, reason: "initial" });
}

/**
 * 関連修正（と明示的に承認したPR）を同じ候補へ取り込み、revisionを進める。
 * - 候補の現在のheadが`expectedHeadSha`（画面で見ていたhead）と一致するときだけ受け付ける
 * - PRごとにマージコミット・base・候補への取り込み済みかを確かめる（`checkRebuildPullRequest`）
 * - 関連修正以外は承認範囲（`decideRcImport`）に収まるものだけ。承認は候補へ記録して残す
 */
export async function requestRcImport(
  input: Context & {
    userId: string | null;
    candidateId: string;
    expectedHeadSha: string;
    selected: { number: number; expectedMergeSha?: string | null }[];
    approveExtra: number[];
    requestKey: string;
    source: "manual" | "fix_series";
    fixSeriesId?: string | null;
  },
): Promise<RcMutationResult> {
  const ctx: Context = input;
  const existing = await existingByRequestKey(input.requestKey);
  if (existing) return existing;
  let row = await loadCandidateRow({ id: input.candidateId });
  if (!row || row.repositoryFullName !== fullNameOf(ctx)) return { ok: false, error: "not_found" };
  if (row.phase !== "review" || row.activeKey === null) return { ok: false, error: "not_reviewable" };
  if (!(await callerSupport(ctx)).supported) return { ok: false, error: "caller_unsupported" };
  if (await expireStalePending(row, new Date())) row = (await loadCandidateRow({ id: input.candidateId }))!;
  if (row.revisions.some((r) => r.status === "requested")) return { ok: false, error: "revision_in_progress" };

  const current = row.revisions.find((r) => r.revision === row!.currentRevision && r.status === "applied");
  const pr = await observeCandidatePullRequest(ctx, row.sequence);
  if (!current?.headSha || !pr || pr.state !== "open" || pr.head.sha !== current.headSha || pr.head.sha !== input.expectedHeadSha) {
    return { ok: false, error: "candidate_changed" };
  }

  const numbers = [...new Map(input.selected.map((item) => [item.number, item])).values()];
  if (numbers.length === 0) return { ok: false, error: "empty_selection" };
  const checked = await Promise.all(
    numbers.map(async ({ number, expectedMergeSha }) => {
      const fetched = await fetchPullRequestForRebuild(ctx.owner, ctx.repo, number, ctx.token);
      const includedInOrigin = fetched?.merge_commit_sha
        ? await isAncestorCommit(ctx.owner, ctx.repo, fetched.merge_commit_sha, current.headSha!, ctx.token)
        : false;
      const result = checkRebuildPullRequest(
        {
          number,
          pr: fetched
            ? { title: fetched.title, mergedAt: fetched.merged_at, mergeSha: fetched.merge_commit_sha, baseRef: fetched.base.ref, headRef: fetched.head.ref }
            : null,
          includedInOrigin,
        },
        expectedMergeSha,
      );
      return { number, mergedAt: fetched?.merged_at ?? null, result };
    }),
  );
  const problems = checked.flatMap(({ number, result }) =>
    result.ok ? [] : [{ number, problem: result.problem, label: REBUILD_PR_PROBLEM_LABEL[result.problem] }],
  );
  if (problems.length > 0) return { ok: false, error: "invalid_selection", problems };

  const approved = jsonArray<ApprovedExtra>(row.approvedExtraPrs);
  const prNumbers = [...new Set(row.revisions.flatMap((r) => (r.prNumber === null ? [] : [r.prNumber])))];
  const fix = await relatedFixPrNumbers(row.repositoryFullName, prNumbers);
  const ordered = orderSelection(checked).map(({ number, result }) => {
    if (!result.ok) throw new Error("unreachable");
    return { number, mergeSha: result.mergeSha, title: result.title };
  });
  const decision = decideRcImport({
    selected: ordered,
    scope: { relatedFixPrs: fix.fixPrs, approvedExtraPrs: approved.map((a) => a.number) },
    approveExtra: input.approveExtra,
  });
  if (!decision.ok) {
    return decision.error === "approval_required"
      ? { ok: false, error: "approval_required", unapproved: decision.unapproved }
      : { ok: false, error: "empty_selection" };
  }

  const nextRevision = Math.max(...row.revisions.map((r) => r.revision)) + 1;
  const now = new Date();
  const candidateId = row.id;
  try {
    await db.$transaction(async (tx) => {
      await tx.releaseCandidateRevision.create({
        data: {
          candidateId,
          revision: nextRevision,
          reason: "fix_import",
          status: "requested",
          requestKey: input.requestKey,
          pendingKey: candidateId,
          expectedHeadSha: current.headSha,
          importedPrs: decision.prs,
          fixSeriesId: input.fixSeriesId ?? null,
          requestedByUserId: input.userId,
        },
      });
      if (decision.newlyApproved.length > 0) {
        const additions: ApprovedExtra[] = decision.prs
          .filter((p) => decision.newlyApproved.includes(p.number))
          .map((p) => ({ number: p.number, mergeSha: p.mergeSha, approvedByUserId: input.userId, approvedAt: now.toISOString(), reason: null }));
        await tx.releaseCandidate.update({ where: { id: candidateId }, data: { approvedExtraPrs: [...approved, ...additions] } });
      }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const again = await existingByRequestKey(input.requestKey);
    if (again) return again;
    return { ok: false, error: "revision_in_progress" };
  }

  try {
    await dispatchReleaseCandidateWorkflow(
      ctx.owner,
      ctx.repo,
      ctx.token,
      serializeRcWorkflowRequest({
        candidate: candidateId,
        sequence: row.sequence,
        revision: nextRevision,
        requestKey: input.requestKey,
        baseHeadSha: current.headSha!,
        mode: "import",
        prs: decision.prs.map((p) => ({ number: p.number, mergeSha: p.mergeSha })),
      }),
    );
  } catch (error) {
    console.error("[release-rc] dispatch failed", fullNameOf(ctx), error);
    const fresh = await loadCandidateRow({ id: candidateId });
    const revision = fresh?.revisions.find((r) => r.revision === nextRevision);
    if (fresh && revision) await failRevision(fresh, revision.id, "リリースworkflowを起動できませんでした", null);
    return { ok: false, error: "dispatch_failed" };
  }
  return { ok: true, candidateId, revision: nextRevision, existing: false };
}

/**
 * マージ済みの候補PRを取り消すとき、マージコミット（main）に入っている正式版を読む。
 * 自動バンプでは取込前に予約が無いことがあるため、取消側が版を確定して消費済みとして残す（developへの同期の検出を失わない）。
 * 版を読めなければ`null`（呼び出し側は取り消さない）
 */
export async function readVersionAtMergeSha(ctx: Context, mergeSha: string): Promise<string | null> {
  const caller = parseFinalizeCallerSupport(await fetchReleaseCallerText(ctx.owner, ctx.repo, ctx.token).catch(() => null));
  if (!caller.supported) return null;
  return readVersionFromText(await fetchFileTextAtRef(ctx.owner, ctx.repo, caller.versionFile, mergeSha, ctx.token).catch(() => null), caller.versionQuery);
}

/**
 * 候補を取り消す。**記録・過去の結果は消さない。** 候補PRは理由のコメントを残して閉じ、ブランチは消さない。
 * mainへのマージ以降は取り消せない
 */
export async function cancelReleaseRc(
  input: Context & { userId: string; candidateId: string; reason: string | null; expectedPhase?: string | null },
): Promise<RcMutationResult> {
  const ctx: Context = input;
  const row = await loadCandidateRow({ id: input.candidateId });
  if (!row || row.repositoryFullName !== fullNameOf(ctx)) return { ok: false, error: "not_found" };
  const phase = parseRcPhase(row.phase);
  if (phase === "cancelled") return { ok: true, candidateId: row.id, revision: row.currentRevision, existing: true };
  if (phase === null || !canCancelRc(phase)) return { ok: false, error: "not_cancellable" };
  // 画面で見ていた段階と違う（別の操作で進んだ）ときは、古い表示からの取消を受け付けない（#4628）
  if (input.expectedPhase && input.expectedPhase !== row.phase) return { ok: false, error: "candidate_changed" };
  // 公開準備中・承認待ち・レビュー中の候補PRがmainへマージ済み（最終検証を確認できず本番反映の追跡へ進めない候補）を、
  // 人が終わらせる出口。**予約した版はマージで使われたので消費済みにしてから**取り消す（版を再利用させず、
  // 版の追跡を失わせない。developへの同期はGit履歴から判定するので、取消でも迂回されない〈#4641〉）。マージの有無を確かめられないときは取り消さない
  let mergedSha: string | null = null;
  let mergedVersion: string | null = null;
  // （レビュー中のままマージ済みの候補〈管理記録だけが残った状態。#4628〉も同じ扱いで、版の追跡を失わせない）
  if (phase === "review" || phase === "preparing" || phase === "awaiting_approval") {
    const prs = await fetchPullRequestsByHead(ctx.owner, ctx.repo, rcBranchName(row.sequence), "main", ctx.token).catch(() => null);
    if (prs === null) return { ok: false, error: "not_cancellable", message: "候補のPRの状態をGitHubから確認できませんでした。時間をおいて再確認してください" };
    const merged = prs.find((pr) => pr.merged_at !== null);
    if (merged) {
      if (!merged.merge_commit_sha) return { ok: false, error: "not_cancellable", message: "マージ済みPRのマージコミットを確認できないため、版の追跡を残せず終了できません" };
      mergedSha = merged.merge_commit_sha;
      // 自動バンプでは取込前に予約が無いことがある。予約が無ければ、マージ後のmainの版を確定して消費済みで残す。
      // 確定できないときは、公開済み版の追跡を失うため取り消さない
      const hasReservation = (await db.releaseVersionReservation.count({ where: { candidateId: row.id, status: { in: ["reserved", "consumed"] } } })) > 0;
      if (!hasReservation) {
        mergedVersion = await readVersionAtMergeSha(ctx, mergedSha).catch(() => null);
        if (!mergedVersion) return { ok: false, error: "not_cancellable", message: "マージ時点の版を確認できないため、版の追跡を残せず終了できません" };
        // 既に台帳にある版は、今回のマージで上がった版とは限らない（版上げ前のマージ・他候補の予約）。取り込めないので取り消さない
        const taken = await db.releaseVersionReservation.findUnique({
          where: { repositoryFullName_version: { repositoryFullName: fullNameOf(ctx), version: mergedVersion } },
        });
        if (taken) return { ok: false, error: "not_cancellable", message: `マージ時点の版 v${mergedVersion} は別の記録に既にあり、自動では終了できません。版の追跡を残すため、手動で確認してください` };
      }
    }
  }
  const now = new Date();
  // 取り消しと版の消費は同時に行う（片方だけ残ると、版の再利用やdevelop同期の検出漏れになる）
  const cancelled = await db.$transaction(async (tx) => {
    const updated = await tx.releaseCandidate.updateMany({
      where: { id: row.id, phase: row.phase },
      data: {
        phase: "cancelled",
        activeKey: null,
        cancelReason: input.reason?.slice(0, 2000) ?? null,
        cancelledByUserId: input.userId,
        cancelledAt: now,
      },
    });
    if (updated.count === 0) return false;
    if (mergedSha) {
      await tx.releaseVersionReservation.updateMany({
        where: { candidateId: row.id, status: "reserved" },
        data: { status: "consumed", consumedAt: now, consumedMergeSha: mergedSha },
      });
      if (mergedVersion) {
        await tx.releaseVersionReservation.create({
          data: { repositoryFullName: fullNameOf(ctx), version: mergedVersion, candidateId: row.id, status: "consumed", consumedAt: now, consumedMergeSha: mergedSha },
        });
      }
    }
    return true;
  }).catch((error: unknown) => {
    // 版の台帳への同時書き込みで負けた場合は、取り消しごと戻る
    if (isUniqueConstraintError(error)) return false;
    throw error;
  });
  if (!cancelled) return { ok: false, error: "candidate_changed" };
  await db.releaseCandidateRevision.updateMany({
    where: { candidateId: row.id, status: "requested" },
    data: { status: "expired", pendingKey: null, failureReason: "候補を取り消したため適用しません" },
  });
  const pr = await observeCandidatePullRequest(ctx, row.sequence).catch(() => null);
  if (pr && pr.state === "open") {
    try {
      await createComment(ctx.owner, ctx.repo, pr.number, ctx.token, {
        body: `リリース候補 ${rcLabel(row.sequence)} を取り消したため閉じます。${input.reason ? `\n\n理由: ${input.reason.slice(0, 500)}` : ""}\n\n記録と検証結果は残ります。`,
      });
      await closePullRequest(ctx.owner, ctx.repo, pr.number, ctx.token);
    } catch (error) {
      // 取り消しの記録は戻さない。PRが開いたままでも新しい候補の作成は妨げない
      console.error("[release-rc] closing candidate pull request failed", fullNameOf(ctx), error);
    }
  }
  return { ok: true, candidateId: row.id, revision: row.currentRevision, existing: false };
}

/**
 * 旧方式の候補（`release-main/vX.Y.Z`）を新方式へ移す。**明示的な操作だけ**で行い、版上げのコミットの親
 * （版を上げる前の固定点）から候補を作る。旧PRは後継を作れた後にだけ閉じ、バンプは取り消さない
 */
export async function migrateLegacyReleaseCandidate(
  input: Context & { userId: string; legacyPrNumber: number; expectedHeadSha: string; requestKey: string },
): Promise<RcMutationResult> {
  const ctx: Context = input;
  const existing = await existingByRequestKey(input.requestKey);
  if (existing) return existing;
  if (!(await callerSupport(ctx)).supported) return { ok: false, error: "caller_unsupported" };
  if (await db.releaseCandidate.findUnique({ where: { activeKey: fullNameOf(ctx) } })) return { ok: false, error: "rc_active" };
  const open = await fetchOpenPullRequestsForBase(ctx.owner, ctx.repo, "main", ctx.token);
  const legacy = open.find((pr) => pr.number === input.legacyPrNumber);
  if (!legacy || !isLegacyReleaseCandidateHeadRef(legacy.head.ref)) return { ok: false, error: "not_found" };
  if (legacy.head.sha !== input.expectedHeadSha) return { ok: false, error: "legacy_changed" };
  const decision = decideLegacyMigration(await fetchCommitSummary(ctx.owner, ctx.repo, legacy.head.sha, ctx.token));
  if (!decision.ok) return { ok: false, error: "not_migratable", message: LEGACY_MIGRATION_PROBLEM_LABEL[decision.reason] };
  const mainSha = await fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token);
  if (!mainSha) return { ok: false, error: "nothing_to_release", message: "mainの先端を取得できませんでした" };
  const frozenPrs = await frozenPullRequests(ctx, mainSha, decision.freezeSha);
  return createCandidate({
    ctx,
    userId: input.userId,
    requestKey: input.requestKey,
    freezeSha: decision.freezeSha,
    frozenPrs,
    reason: "migration",
    migratedFrom: { prNumber: legacy.number, headSha: legacy.head.sha },
  });
}

export type RcReportResult =
  | { ok: true; outcome: "applied" | "failed" | "ignored" | "waiting" }
  | { ok: false; reason: "unknown_repository" | "unknown_request" };

/**
 * workflowからの報告（`POST /api/dispatch/release-rc`）。信じるのは要求キーと結果の種別だけで、
 * 適用されたかは候補ブランチをGitHubから取り直して決める。失敗の理由は機密を除いた短い文だけを残す
 */
export async function recordRcReport(input: {
  repositoryFullName: string;
  requestKey: string;
  outcome: "applied" | "failed";
  runId: number | null;
  reason: string | null;
}): Promise<RcReportResult> {
  const repository = await db.repository.findFirst({ where: { fullName: input.repositoryFullName }, include: { installation: true } });
  if (!repository) return { ok: false, reason: "unknown_repository" };
  const revision = await db.releaseCandidateRevision.findUnique({ where: { requestKey: input.requestKey } });
  if (!revision) return { ok: false, reason: "unknown_request" };
  const candidate = await loadCandidateRow({ id: revision.candidateId });
  if (!candidate || candidate.repositoryFullName !== input.repositoryFullName) return { ok: false, reason: "unknown_request" };
  const runUrl = input.runId !== null ? `https://github.com/${input.repositoryFullName}/actions/runs/${input.runId}` : null;
  if (revision.status !== "requested") return { ok: true, outcome: "ignored" };
  if (input.outcome === "failed") {
    await failRevision(candidate, revision.id, input.reason?.trim() || "リリースworkflowが候補の作成・更新に失敗しました", runUrl);
    return { ok: true, outcome: "failed" };
  }
  const token = await getInstallationToken(repository.installation.installationId);
  const ctx: Context = { owner: repository.ownerLogin, repo: repository.name, token };
  return { ok: true, outcome: await reconcileRevision({ ctx, candidate, revisionId: revision.id, runUrl }) };
}

/** 候補PR（新方式）に対応する、取り込みを受け付ける段階の候補。無ければnull（修正系列の接続用） */
export async function findReviewableRcForPullRequest(
  repositoryFullName: string,
  prNumber: number,
): Promise<{ id: string; sequence: number } | null> {
  const revision = await db.releaseCandidateRevision.findFirst({
    where: { prNumber, status: "applied", candidate: { repositoryFullName, phase: "review", activeKey: { not: null } } },
    select: { candidate: { select: { id: true, sequence: true } } },
  });
  return revision?.candidate ?? null;
}

/**
 * 修正系列（#4317）が作り直しを依頼した後の、候補PR（新方式）のrevision。同じ巡回でまとめて依頼した系列は
 * 同じ時刻に作り直しを確保するので、その時刻以降に作られた取り込みのrevisionを見る。未完了なら照合して取り込む
 * （workflowの報告が届かなかった場合の回復）。依頼が無ければnull
 */
export async function observeRcRevisionAfter(input: {
  repositoryFullName: string;
  prNumber: number;
  since: Date;
}): Promise<{ status: RcRevisionStatus; prNumber: number | null; baseSha: string | null; headSha: string | null } | null> {
  const find = () =>
    db.releaseCandidateRevision.findFirst({
      where: {
        reason: "fix_import",
        createdAt: { gte: new Date(input.since.getTime() - 60_000) },
        candidate: { repositoryFullName: input.repositoryFullName, revisions: { some: { prNumber: input.prNumber } } },
      },
      orderBy: { createdAt: "desc" },
    });
  let row = await find();
  if (!row) return null;
  if (row.status === "requested") {
    await reconcileRcCandidate(input.repositoryFullName, row.candidateId).catch((error: unknown) => {
      console.error("[release-rc] reconcile failed", input.repositoryFullName, error);
    });
    row = (await find()) ?? row;
  }
  return { status: row.status as RcRevisionStatus, prNumber: row.prNumber, baseSha: row.baseSha, headSha: row.headSha };
}

/** 未完了の更新要求の失効と照合だけを行う（巡回用）。画面の読み込み（`loadRcOverview`）と同じ処理 */
export async function reconcileRcCandidate(repositoryFullName: string, candidateId: string): Promise<void> {
  const repository = await db.repository.findFirst({ where: { fullName: repositoryFullName }, include: { installation: true } });
  if (!repository) return;
  const row = await loadCandidateRow({ id: candidateId });
  if (!row) return;
  const ctx: Context = { owner: repository.ownerLogin, repo: repository.name, token: await getInstallationToken(repository.installation.installationId) };
  await reconcilePending(ctx, row);
}

/** 修正系列の自動取り込みの要求キー。同じ系列・同じ前提headの再試行（巡回の重なり・再起動）で同じキーになる */
export function rcFixSeriesRequestKey(seriesId: string, headSha: string): string {
  return `fs-${seriesId.replace(/[^A-Za-z0-9]/g, "").slice(0, 30)}-${headSha.slice(0, 12)}`;
}
