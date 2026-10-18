import type { Prisma, ReleaseCompletionRun, ReleasePublishApproval } from "@prisma/client";

import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { fetchMainHeadSha } from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import {
  APPROVAL_RETRYABLE_STOP_REASONS,
  isReleaseCompletionActive,
  RELEASE_COMPLETION_COST_LIMIT_USD,
  RELEASE_COMPLETION_SCOPE_PRODUCTION,
  releaseCompletionStatusLabel,
  describeMergeWait,
  isLongMergeWait,
  releaseCompletionStopMessage,
  type ReleaseCompletionStopReason,
} from "@/lib/release-completion";
import {
  decidePublishApprovalValidity,
  describePublishProgress,
  isWithinApprovalTarget,
  PUBLISH_APPROVAL_ALLOWED_CATEGORIES,
  PUBLISH_APPROVAL_INVALID_LABEL,
  PUBLISH_APPROVAL_STATUS_LABEL,
  PUBLISH_APPROVAL_TTL_MS,
  PUBLISH_PROGRESS_LABEL,
  type PublishApprovalFinalization,
  type PublishApprovalInvalidReason,
  type PublishApprovalStatus,
  type PublishApprovalValidity,
  type PublishProgressStage,
} from "@/lib/release-publish-approval";

/**
 * 公開承認（#4666）の外部操作。判断は`release-publish-approval.ts`の純関数が持つ。
 *
 * - 承認は`activeKey`（候補ID）の一意制約で候補ごとに1本。要求キーで二重押し・再送を弾く
 * - 自動公開は承認者を開始者とした`until_production`のリリース完了系列（#4480）が進める。マージ・deploy追跡・
 *   稼働確認・本番復旧への引継ぎは系列の既存の処理をそのまま使い、ここは開始・承認の検査・確保だけを持つ
 * - **取消と本番マージの競合は承認行の条件付き更新（`active`→`merging`／`active`→`revoked`）で1つに決める。**
 *   どちらか先に取った方だけが進む（古い承認・取消後の遅延イベントから公開しない）
 */

type Ctx = { owner: string; repo: string; token: string };
type Tx = Prisma.TransactionClient;

const ACTIVE: PublishApprovalStatus[] = ["active", "merging"];

export type PublishApprovalRunView = {
  id: string;
  status: string;
  statusLabel: string;
  active: boolean;
  note: string | null;
  stopReason: string | null;
  stopMessage: string | null;
  /** 本番マージの条件を待っている理由（#4725）。`merging`で待つ間だけ入る */
  waitMessage?: string | null;
  /** 同じ理由で長く待っているか */
  waitStalled?: boolean;
};

export type PublishApprovalView = {
  id: string;
  status: PublishApprovalStatus;
  statusLabel: string;
  approvedByUserId: string;
  approvedAt: string;
  expiresAt: string;
  revision: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  bumpPolicy: string;
  allowedChanges: string[];
  contents: { number: number; title: string }[];
  invalidReason: string | null;
  invalidMessage: string | null;
  invalidDiff: string[];
  revokedAt: string | null;
  mergeSha: string | null;
  run: PublishApprovalRunView | null;
  /** 画面に出す段階（実処理の記録から導く） */
  progress: PublishProgressStage;
  progressLabel: string;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function contentsOf(value: unknown): { number: number; title: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const item = v as { number?: unknown; title?: unknown } | null;
    return item && typeof item.number === "number" ? [{ number: item.number, title: typeof item.title === "string" ? item.title : "" }] : [];
  });
}

function toRunView(run: ReleaseCompletionRun | null): PublishApprovalRunView | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    statusLabel: releaseCompletionStatusLabel(run.status, true),
    active: isReleaseCompletionActive(run.status),
    note: run.note,
    stopReason: run.stopReason,
    stopMessage: releaseCompletionStopMessage(run.stopReason, run.stopDetail),
    waitMessage: run.status === "merging" ? describeMergeWait(run.waitReason) : null,
    waitStalled: run.status === "merging" && isLongMergeWait(run.waitSince, new Date()),
  };
}

export function toPublishApprovalView(row: ReleasePublishApproval, run: ReleaseCompletionRun | null, phase: string): PublishApprovalView {
  const status = row.status as PublishApprovalStatus;
  const runView = toRunView(run);
  const progress = describePublishProgress({ phase, approval: { status }, run: runView ? { status: runView.status, active: runView.active } : null });
  const reason = row.invalidReason as PublishApprovalInvalidReason | null;
  return {
    id: row.id,
    status,
    statusLabel: PUBLISH_APPROVAL_STATUS_LABEL[status] ?? row.status,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revision: row.revision,
    prNumber: row.prNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    bumpPolicy: row.bumpPolicy,
    allowedChanges: strings(row.allowedChanges),
    contents: contentsOf(row.contents),
    invalidReason: row.invalidReason,
    invalidMessage: reason ? [PUBLISH_APPROVAL_INVALID_LABEL[reason] ?? reason, row.invalidDetail].filter(Boolean).join("（") + (row.invalidDetail ? "）" : "") : null,
    invalidDiff: strings(row.invalidDiff),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    mergeSha: row.mergeSha,
    run: runView,
    progress,
    progressLabel: PUBLISH_PROGRESS_LABEL[progress],
  };
}

/** 候補の最新の公開承認（画面用）。無ければnull（既存の候補で承認の記録が無いもの） */
export async function loadPublishApprovalView(candidateId: string, phase: string): Promise<PublishApprovalView | null> {
  const row = await db.releasePublishApproval.findFirst({ where: { candidateId }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const run = row.completionRunId ? await db.releaseCompletionRun.findUnique({ where: { id: row.completionRunId } }) : null;
  return toPublishApprovalView(row, run, phase);
}

/** 候補に有効な公開承認があるか（候補の状態表示で「本番承認待ち」を出さないため） */
export async function hasActivePublishApproval(candidateId: string): Promise<boolean> {
  const row = await db.releasePublishApproval.findUnique({ where: { activeKey: candidateId }, select: { id: true } });
  return row !== null;
}

async function loadFinalizations(candidateId: string): Promise<PublishApprovalFinalization[]> {
  const rows = await db.releaseCandidateFinalization.findMany({ where: { candidateId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    status: r.status,
    preBaseSha: r.preBaseSha,
    preHeadSha: r.preHeadSha,
    finalBaseSha: r.finalBaseSha,
    finalHeadSha: r.finalHeadSha,
    files: Array.isArray(r.diffFiles) ? (r.diffFiles as { path: string; category: string; versionLinesOnly?: boolean }[]) : [],
  }));
}

/** 承認を失効させる（`active`のときだけ）。失効の理由と差分を残し、承認者が見られるようにする */
export async function invalidatePublishApproval(id: string, reason: PublishApprovalInvalidReason, detail: string | null, diff: string[], now = new Date()): Promise<boolean> {
  const updated = await db.releasePublishApproval.updateMany({
    where: { id, status: "active" },
    data: { status: "invalidated", activeKey: null, invalidReason: reason, invalidDetail: detail, invalidDiff: diff, invalidatedAt: now },
  });
  return updated.count === 1;
}

// ---------------------------------------------------------------------------
// 承認の作成（公開準備の開始と同じトランザクション）

export type PreparedApproval =
  | { kind: "reuse"; approvalId: string }
  | { kind: "create"; data: Prisma.ReleasePublishApprovalUncheckedCreateInput }
  | { kind: "conflict"; error: "run_active"; message: string };

/**
 * 公開準備の開始（＝公開承認）の前段。**同じ対象の再試行なら既存の承認を使い回し**、対象が変わった承認は失効させて
 * 新しく作る。同じリポジトリで別の候補の完了系列が進行中なら受け付けない（自動公開を2本走らせない）
 */
export async function preparePublishApproval(input: {
  repositoryFullName: string;
  candidateId: string;
  contract: { revision: number; prNumber: number; baseSha: string; headSha: string };
  bumpPolicy: string;
  contents: { number: number; title: string }[];
  userId: string;
  requestKey: string;
  now: Date;
}): Promise<PreparedApproval> {
  const run = await db.releaseCompletionRun.findUnique({ where: { activeKey: input.repositoryFullName } });
  if (run && run.candidatePrNumber !== input.contract.prNumber) {
    return { kind: "conflict", error: "run_active", message: `このリポジトリでは別のリリース候補（#${run.candidatePrNumber}）の完了系列が進行中です` };
  }
  const existing = await db.releasePublishApproval.findUnique({ where: { activeKey: input.candidateId } });
  if (existing && existing.status === "active" && existing.expiresAt.getTime() > input.now.getTime()) {
    const finalizations = await loadFinalizations(input.candidateId);
    if (isWithinApprovalTarget({ approval: existing, finalizations, target: input.contract })) return { kind: "reuse", approvalId: existing.id };
    await invalidatePublishApproval(
      existing.id,
      input.contract.baseSha !== existing.baseSha ? "main_advanced" : "candidate_changed",
      `${existing.headSha.slice(0, 7)} → ${input.contract.headSha.slice(0, 7)}`,
      [],
      input.now,
    );
  } else if (existing && existing.status === "active") {
    await invalidatePublishApproval(existing.id, "expired", null, [], input.now);
  } else if (existing) {
    // 本番マージを確保済み（merging）の承認がある候補は、新しく承認しない
    return { kind: "conflict", error: "run_active", message: "この候補は本番公開の処理中です" };
  }
  return {
    kind: "create",
    data: {
      repositoryFullName: input.repositoryFullName,
      candidateId: input.candidateId,
      revision: input.contract.revision,
      prNumber: input.contract.prNumber,
      baseSha: input.contract.baseSha,
      headSha: input.contract.headSha,
      bumpPolicy: input.bumpPolicy,
      allowedChanges: [...PUBLISH_APPROVAL_ALLOWED_CATEGORIES],
      contents: input.contents,
      status: "active",
      activeKey: input.candidateId,
      requestKey: `pa-${input.requestKey}`.slice(0, 64),
      approvedByUserId: input.userId,
      approvedAt: input.now,
      expiresAt: new Date(input.now.getTime() + PUBLISH_APPROVAL_TTL_MS),
    },
  };
}

/** `preparePublishApproval`の結果をトランザクション内で確定し、承認IDを返す */
export async function commitPublishApproval(tx: Tx, prepared: Exclude<PreparedApproval, { kind: "conflict" }>): Promise<string> {
  if (prepared.kind === "reuse") return prepared.approvalId;
  const row = await tx.releasePublishApproval.create({ data: prepared.data });
  return row.id;
}

// ---------------------------------------------------------------------------
// 自動公開の系列

export type EnsureRunResult =
  | { ok: true; runId: string; created: boolean }
  | { ok: false; error: "approval_not_active" | "run_active" | "pull_request_unobserved" | "approval_invalid"; message: string };

/**
 * 承認に紐づく自動公開の系列を用意する（無ければ作る・終わっていれば作り直す）。復旧用の`startReleaseCompletionRun`
 * （問題の無い候補は`nothing_to_recover`で拒否する）とは別の入口で、初期状態は`checking`。
 * 作る前に承認が今も範囲内かを確かめる（古い承認から系列を始めない）
 */
export async function ensurePublishApprovalRun(ctx: Ctx, approvalId: string, now = new Date()): Promise<EnsureRunResult> {
  const approval = await db.releasePublishApproval.findUnique({ where: { id: approvalId } });
  if (!approval || approval.status !== "active") return { ok: false, error: "approval_not_active", message: "公開承認が有効ではありません" };
  const repositoryFullName = approval.repositoryFullName;

  if (approval.completionRunId) {
    const linked = await db.releaseCompletionRun.findUnique({ where: { id: approval.completionRunId } });
    if (linked && linked.activeKey !== null) return { ok: true, runId: linked.id, created: false };
  }

  const [pull, mainSha, candidate] = await Promise.all([
    fetchPullRequest(ctx.owner, ctx.repo, approval.prNumber, ctx.token).catch(() => null),
    fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null),
    db.releaseCandidate.findUnique({ where: { id: approval.candidateId }, select: { phase: true } }),
  ]);
  if (!pull || !pull.base?.sha || !mainSha || !candidate) return { ok: false, error: "pull_request_unobserved", message: "候補のPR・mainの状態を取得できませんでした" };
  const validity = decidePublishApprovalValidity({
    approval: { status: "active", baseSha: approval.baseSha, headSha: approval.headSha, expiresAt: approval.expiresAt },
    now,
    candidatePhase: candidate.phase,
    finalizations: await loadFinalizations(approval.candidateId),
    observed: { headSha: pull.head.sha, mainSha },
  });
  if (validity && !validity.valid) {
    await invalidatePublishApproval(approval.id, validity.reason, validity.detail, validity.diff, now);
    return { ok: false, error: "approval_invalid", message: PUBLISH_APPROVAL_INVALID_LABEL[validity.reason] };
  }

  const existing = await db.releaseCompletionRun.findUnique({ where: { activeKey: repositoryFullName } });
  if (existing) {
    if (existing.candidatePrNumber !== approval.prNumber) {
      return { ok: false, error: "run_active", message: `このリポジトリでは別のリリース候補（#${existing.candidatePrNumber}）の完了系列が進行中です` };
    }
    // 同じ候補の復旧系列（「リリース完了まで進める」）が進行中なら、それに承認を紐付けて本番まで進める
    const attached = await db.releaseCompletionRun.updateMany({
      where: { id: existing.id, activeKey: { not: null } },
      data: { publishApprovalId: approval.id, scope: RELEASE_COMPLETION_SCOPE_PRODUCTION },
    });
    if (attached.count !== 1) return { ok: false, error: "run_active", message: "完了系列の状態が変わりました。もう一度お試しください" };
    await db.releasePublishApproval.updateMany({ where: { id: approval.id }, data: { completionRunId: existing.id } });
    return { ok: true, runId: existing.id, created: false };
  }

  try {
    const run = await db.releaseCompletionRun.create({
      data: {
        repositoryFullName,
        originPrNumber: approval.prNumber,
        originHeadSha: pull.head.sha,
        releaseVersion: null,
        scope: RELEASE_COMPLETION_SCOPE_PRODUCTION,
        startedByUserId: approval.approvedByUserId,
        // 承認の期限を超えて系列を続けない
        expiresAt: approval.expiresAt,
        status: "checking",
        activeKey: repositoryFullName,
        candidatePrNumber: approval.prNumber,
        candidateHeadSha: pull.head.sha,
        candidateBaseSha: pull.base.sha!,
        candidatePrNumbers: [approval.prNumber],
        costLimitUsd: RELEASE_COMPLETION_COST_LIMIT_USD,
        publishApprovalId: approval.id,
        note: "公開承認済み。正式バンプと最終検証を待っています",
      },
    });
    await db.releasePublishApproval.updateMany({ where: { id: approval.id }, data: { completionRunId: run.id } });
    return { ok: true, runId: run.id, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return { ok: false, error: "run_active", message: "同じリポジトリで完了系列が同時に開始されました。状態を取り直してください" };
  }
}

/**
 * 系列の巡回ごとの承認の検査。**本番マージ前の承認だけ**を、今の候補・mainと照合する。
 * 失効していれば失効の記録を残して`invalid`を返す（系列は呼び出し側が理由付きで止める）。観測できなければnull
 */
export async function checkPublishApprovalForRun(
  ctx: Ctx,
  run: Pick<ReleaseCompletionRun, "publishApprovalId">,
  observed: { headSha: string } | null,
  now: Date,
): Promise<{ state: "valid" | "past_merge" } | { state: "invalid"; reason: ReleaseCompletionStopReason; detail: string } | null> {
  if (!run.publishApprovalId) return { state: "valid" };
  const approval = await db.releasePublishApproval.findUnique({ where: { id: run.publishApprovalId } });
  if (!approval) return { state: "invalid", reason: "approval_invalidated", detail: "承認の記録が見つかりません" };
  if (approval.status === "merging" || approval.status === "consumed") return { state: "past_merge" };
  if (approval.status === "revoked") return { state: "invalid", reason: "approval_revoked", detail: "" };
  if (approval.status === "invalidated") {
    return { state: "invalid", reason: "approval_invalidated", detail: PUBLISH_APPROVAL_INVALID_LABEL[approval.invalidReason as PublishApprovalInvalidReason] ?? "" };
  }
  if (observed === null) return null;
  const [mainSha, candidate] = await Promise.all([
    fetchMainHeadSha(ctx.owner, ctx.repo, ctx.token).catch(() => null),
    db.releaseCandidate.findUnique({ where: { id: approval.candidateId }, select: { phase: true } }),
  ]);
  if (!mainSha || !candidate) return null;
  const validity: PublishApprovalValidity | null = decidePublishApprovalValidity({
    approval: { status: "active", baseSha: approval.baseSha, headSha: approval.headSha, expiresAt: approval.expiresAt },
    now,
    candidatePhase: candidate.phase,
    finalizations: await loadFinalizations(approval.candidateId),
    observed: { headSha: observed.headSha, mainSha },
  });
  if (validity === null) return null;
  if (validity.valid) return { state: "valid" };
  await invalidatePublishApproval(approval.id, validity.reason, validity.detail, validity.diff, now);
  const diff = validity.diff.length > 0 ? ` 変わったファイル: ${validity.diff.slice(0, 10).join("、")}` : "";
  return { state: "invalid", reason: "approval_invalidated", detail: `${PUBLISH_APPROVAL_INVALID_LABEL[validity.reason]}${validity.detail ? `（${validity.detail}）` : ""}${diff}` };
}

/** 本番マージの確保。**`active`の承認だけを`merging`へ進める**（取消・失効と競合したら確保できない） */
export async function claimPublishApprovalForMerge(approvalId: string, now: Date): Promise<boolean> {
  const claimed = await db.releasePublishApproval.updateMany({
    where: { id: approvalId, status: "active", expiresAt: { gt: now } },
    data: { status: "merging" },
  });
  return claimed.count === 1;
}

/** マージの結果を承認へ反映する。成功なら消費済み、失敗なら`active`へ戻す（同じ承認で再開できる） */
export async function settlePublishApprovalMerge(approvalId: string, result: { merged: true; mergeSha: string | null } | { merged: false }, now: Date): Promise<void> {
  if (result.merged) {
    await db.releasePublishApproval.updateMany({
      where: { id: approvalId, status: "merging" },
      data: { status: "consumed", activeKey: null, mergeSha: result.mergeSha, consumedAt: now },
    });
    return;
  }
  await db.releasePublishApproval.updateMany({ where: { id: approvalId, status: "merging" }, data: { status: "active" } });
}

/**
 * 系列が止まったときの承認の扱い。対象の変化・期限切れでは承認ごと終え、検証の失敗・取得不能などの
 * **同じ処理をやり直せば済む停止では承認を保つ**（再開・再試行で承認し直させない）
 */
export async function settlePublishApprovalOnStop(approvalId: string, reason: ReleaseCompletionStopReason, now: Date): Promise<void> {
  if (APPROVAL_RETRYABLE_STOP_REASONS.has(reason)) return;
  if (reason === "approval_invalidated" || reason === "approval_revoked") return;
  const map: Partial<Record<ReleaseCompletionStopReason, PublishApprovalInvalidReason>> = {
    timed_out: "expired",
    candidate_closed: "candidate_cancelled",
    candidate_changed: "candidate_changed",
    base_changed: "main_advanced",
  };
  await invalidatePublishApproval(approvalId, map[reason] ?? "candidate_changed", releaseCompletionStopMessage(reason, null), [], now);
}

export type RevokeResult = { ok: true } | { ok: false; error: "not_found" | "already_publishing" | "not_active" };

/**
 * 自動公開の取消。**本番マージを確保する前（`active`）だけ**取り消せる。取り消したら系列を止める
 * （系列はマージ直前に承認の確保を取り直すので、取消の後に古い承認から公開しない）
 */
export async function revokePublishApproval(input: { repositoryFullName: string; candidateId: string; userId: string; now?: Date }): Promise<RevokeResult> {
  const now = input.now ?? new Date();
  const approval = await db.releasePublishApproval.findFirst({
    where: { repositoryFullName: input.repositoryFullName, candidateId: input.candidateId, status: { in: ACTIVE } },
  });
  if (!approval) return { ok: false, error: "not_found" };
  if (approval.status === "merging") return { ok: false, error: "already_publishing" };
  const revoked = await db.releasePublishApproval.updateMany({
    where: { id: approval.id, status: "active" },
    data: { status: "revoked", activeKey: null, revokedByUserId: input.userId, revokedAt: now },
  });
  if (revoked.count !== 1) {
    const latest = await db.releasePublishApproval.findUnique({ where: { id: approval.id }, select: { status: true } });
    return { ok: false, error: latest?.status === "merging" || latest?.status === "consumed" ? "already_publishing" : "not_active" };
  }
  if (approval.completionRunId) {
    await db.releaseCompletionRun.updateMany({
      where: { id: approval.completionRunId, activeKey: { not: null }, mergeSha: null },
      data: { status: "stopped", activeKey: null, stopReason: "approval_revoked", stoppedByUserId: input.userId, stoppedAt: now },
    });
  }
  return { ok: true };
}

/** 系列を利用者が止めたとき、紐づく承認も取り消す（止めた後に古い承認から再開しない） */
export async function revokeApprovalForStoppedRun(approvalId: string, userId: string, now: Date): Promise<void> {
  await db.releasePublishApproval.updateMany({
    where: { id: approvalId, status: "active" },
    data: { status: "revoked", activeKey: null, revokedByUserId: userId, revokedAt: now },
  });
}
