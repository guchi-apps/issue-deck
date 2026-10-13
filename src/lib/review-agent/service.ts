import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import {
  authorizeRepository,
  recordReviewAgentAudit,
  type ReviewAgentPrincipal,
  type ReviewAgentScope,
} from "@/lib/review-agent/auth";
import {
  claimInternalSession,
  loadInternalViewForUi,
  pauseInternalByReport,
  recordInternalReview,
  recordInternalTest,
  releaseInternalSession,
  resumeInternal,
  type InternalReportError,
  type InternalStatusView,
} from "@/lib/release-fix-internal-run";
import { isReleaseFixActive } from "@/lib/release-fix-series";
import { listReleaseVerificationDetails } from "@/lib/release-verification";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";
import type { ReleaseVerificationSection } from "@/lib/release-verification-summary";

/**
 * 外部エージェント向けの全体レビュー・修正の取得と更新（#4588）。REST（`/api/review-agent/tools/*`）とMCP（`/api/mcp/review-agent`）は
 * **この1つのツール定義と`callReviewAgentTool`だけ**を呼ぶので、認可・状態遷移・応答が食い違わない。
 *
 * - 既存の台帳（`ReleaseVerification`・`ReleaseCandidate/Revision/Finalization`・`ReleaseFixSeries`・内部確認の記録）だけを読み、新しい結果の保存先は持たない
 * - **取得はGitHubを呼ばず、書き込まない**（監査の記録も更新と拒否だけ）。更新は既存の内部確認の関数へ委譲し、対象SHA・担当の世代・冪等キーで受理を決める
 * - 任意SQL・テーブルCRUD・DB資格情報は公開しない。返すのは上記の台帳から組み立てた決まった形だけ
 */

export type ToolFailure = {
  ok: false;
  status: number;
  error: string;
  message: string;
  /** 状態を取り直す・検証し直す必要がある（旧SHA・旧担当・競合など） */
  refetchRequired?: boolean;
  details?: Record<string, unknown>;
};
export type ToolSuccess = { ok: true; data: unknown; replayed?: boolean };
export type ToolResult = ToolSuccess | ToolFailure;

type Args = Record<string, unknown>;
type ToolContext = { principal: ReviewAgentPrincipal };
type ToolDefinition = {
  name: string;
  description: string;
  scope: ReviewAgentScope;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Args) => Promise<ToolResult>;
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const AGENT_PATTERN = /^[\w.-]{1,60}$/;
const IDEM_PATTERN = /^[\w.:-]{8,120}$/;

const fail = (status: number, error: string, message: string, extra: Partial<ToolFailure> = {}): ToolFailure => ({ ok: false, status, error, message, ...extra });
const ok = (data: unknown): ToolSuccess => ({ ok: true, data });

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.slice(0, max) : null;
}

/** 配列を切り出す。**切り捨てたときは件数と次の位置を必ず返し、黙って省略しない** */
export function pageOf<T>(list: readonly T[], offset: number, limit: number) {
  const items = list.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: list.length, offset, limit, nextOffset: next < list.length ? next : null, truncated: next < list.length };
}

const STATUS_BY_ERROR: Record<string, number> = {
  series_not_found: 404,
  repository_not_found: 404,
  branch_not_found: 404,
  invalid_report: 400,
  input_required: 409,
};
const REFETCH_ERRORS = new Set(["stale_sha", "stale_assignee", "lease_held", "paused", "not_paused", "not_resumable"]);

function fromInternalError(error: InternalReportError): ToolFailure {
  return fail(STATUS_BY_ERROR[error.error] ?? 409, error.error, error.message, {
    refetchRequired: REFETCH_ERRORS.has(error.error),
    ...(error.error === "stale_sha" ? { details: { currentSha: error.currentSha } } : {}),
  });
}

function agentName(ctx: ToolContext, args: Args): string | null {
  const label = typeof args.agent === "string" && AGENT_PATTERN.test(args.agent) ? args.agent : null;
  return label ? `ext:${ctx.principal.tokenId}:${label}` : null;
}
const isSelf = (ctx: ToolContext) => (assigneeName: string) => assigneeName.startsWith(`ext:${ctx.principal.tokenId}:`);

async function targetOf(ctx: ToolContext, args: Args): Promise<{ repository: string } | ToolFailure> {
  const repository = typeof args.repository === "string" && REPOSITORY_PATTERN.test(args.repository) ? args.repository : null;
  if (!repository) return fail(400, "invalid_request", "repository を owner/name の形で指定してください");
  const access = await authorizeRepository(ctx.principal, repository);
  if (!access.ok) {
    return access.code === "repository_not_allowed"
      ? fail(403, "repository_not_allowed", "このトークンは、そのrepositoryへのアクセスを許可されていません")
      : fail(404, "repository_not_found", "repositoryが見つかりません（連携が外れている可能性があります）");
  }
  return { repository };
}
const isFailure = (v: unknown): v is ToolFailure => typeof v === "object" && v !== null && "ok" in v && (v as { ok: unknown }).ok === false;

// ------------------------------------------------------------------------------------------------ 取得

type SectionView = ReturnType<typeof viewSection>;
function viewSection(section: ReleaseVerificationSection, unverifiedScope: string | null, offset: number, limit: number) {
  return {
    state: section.state,
    reason: section.reason,
    summary: section.summary,
    evidenceUrl: section.evidenceUrl,
    agent: section.agent,
    updatedAt: section.updatedAt,
    unverifiedScope,
    findings: pageOf(section.findings, offset, limit),
    suggestions: pageOf(section.suggestions, offset, limit),
    review: section.review,
    affectedPullRequests: section.affectedPullRequests,
    affectedFiles: pageOf(section.affectedFiles, 0, 200),
    reviewedFiles: section.reviewedFiles,
    totalFiles: section.totalFiles,
    diagnostic: section.diagnostic,
  };
}

const HISTORY_ROW_LIMIT = 50;
const FIX_LIMIT = 50;
const FIX_INTERNAL_LIMIT = 10;
const REVISION_LIMIT = 100;

async function listCandidates(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const target = await targetOf(ctx, args);
  if (isFailure(target)) return target;
  const limit = args.limit === undefined ? 20 : int(args.limit, 1, 50);
  const cursor = args.cursor === undefined ? null : int(args.cursor, 1, 1_000_000_000);
  if (limit === null || (args.cursor !== undefined && cursor === null)) return fail(400, "invalid_request", "limit は1〜50、cursor は候補番号（前の応答のnextCursor）で指定してください");
  const rows = await db.releaseCandidate.findMany({
    where: { repositoryFullName: target.repository, ...(cursor ? { sequence: { lt: cursor } } : {}) },
    orderBy: { sequence: "desc" },
    take: limit + 1,
    include: { revisions: { where: { status: "applied" }, orderBy: { revision: "desc" }, take: 1 } },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return ok({
    repository: target.repository,
    candidates: page.map((c) => ({
      sequence: c.sequence,
      phase: c.phase,
      active: c.activeKey !== null,
      currentRevision: c.currentRevision,
      frozenDevelopSha: c.frozenDevelopSha,
      cancelled: c.cancelledAt !== null,
      cancelReason: c.cancelReason,
      createdAt: c.createdAt.toISOString(),
      latestApplied: c.revisions[0] ? { revision: c.revisions[0].revision, prNumber: c.revisions[0].prNumber, baseSha: c.revisions[0].baseSha, headSha: c.revisions[0].headSha } : null,
    })),
    page: { limit, hasMore, nextCursor: hasMore ? page[page.length - 1].sequence : null },
  });
}

async function getCandidate(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const target = await targetOf(ctx, args);
  if (isFailure(target)) return target;
  const sequence = int(args.sequence, 1, 1_000_000_000);
  const offset = args.findingsOffset === undefined ? 0 : int(args.findingsOffset, 0, 1_000_000);
  const limit = args.findingsLimit === undefined ? 20 : int(args.findingsLimit, 1, 50);
  if (sequence === null || offset === null || limit === null) return fail(400, "invalid_request", "sequence（候補番号）と、findingsOffset（0以上）・findingsLimit（1〜50）を確かめてください");
  const candidate = await db.releaseCandidate.findFirst({
    where: { repositoryFullName: target.repository, sequence },
    include: { revisions: { orderBy: { revision: "desc" }, take: REVISION_LIMIT + 1 }, finalizations: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!candidate) return fail(404, "candidate_not_found", "その候補が見つかりません");

  const revisions = candidate.revisions.slice(0, REVISION_LIMIT);
  const applied = revisions.filter((r) => r.status === "applied" && r.prNumber !== null && r.baseSha && r.headSha);
  const current = applied.find((r) => r.revision === candidate.currentRevision) ?? null;
  const prNumbers = [...new Set(applied.map((r) => r.prNumber as number))];

  // 検証の履歴: 現行の対象・旧SHA・引き継ぎ（根拠つき）を区別して返す
  const history: Array<Record<string, unknown>> = [];
  const currentRows: Awaited<ReturnType<typeof listReleaseVerificationDetails>> = [];
  for (const pr of prNumbers.slice(0, 20)) {
    const rows = await listReleaseVerificationDetails(target.repository, pr);
    for (const row of rows) {
      const isCurrent = current !== null && pr === current.prNumber && row.baseSha === current.baseSha && row.headSha === current.headSha;
      if (isCurrent) currentRows.push(row);
      const inheritedFrom = "inheritedFromHeadSha" in row ? String((row as { inheritedFromHeadSha: unknown }).inheritedFromHeadSha) : null;
      const raw = (typeof row.findings === "object" && row.findings !== null ? row.findings : {}) as { findings?: unknown[] };
      history.push({
        prNumber: pr,
        kind: row.kind,
        state: row.state,
        baseSha: row.baseSha,
        headSha: row.headSha,
        relation: inheritedFrom ? "inherited" : isCurrent ? "current" : "stale_sha",
        inheritedFromHeadSha: inheritedFrom,
        message: row.message,
        findingCount: Array.isArray(raw.findings) ? raw.findings.length : 0,
        summary: row.summary,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  history.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  let verification: { integration: SectionView; aiReview: SectionView; gateStatus: string; blockers: unknown[]; target: { baseSha: string; headSha: string } } | null = null;
  if (current) {
    const target2 = { baseSha: current.baseSha as string, headSha: current.headSha as string };
    const summary = await loadReleaseVerificationSummary(target.repository, current.prNumber as number, target2);
    const scope = (kind: string) => currentRows.find((r) => r.kind === kind)?.unverifiedScope ?? null;
    verification = {
      integration: viewSection(summary.integration, scope("integration"), 0, limit),
      aiReview: viewSection(summary.aiReview, scope("ai_review"), offset, limit),
      gateStatus: summary.gateStatus,
      blockers: summary.blockers,
      target: summary.target,
    };
  }

  // 関連する修正Issue・系列（候補のPRを起点にした系列）
  const seriesRows = prNumbers.length
    ? await db.releaseFixSeries.findMany({ where: { repositoryFullName: target.repository, releasePrNumber: { in: prNumbers } }, orderBy: { createdAt: "desc" }, take: FIX_LIMIT + 1 })
    : [];
  const fixes = [];
  for (const [index, series] of seriesRows.slice(0, FIX_LIMIT).entries()) {
    const withInternal = index < FIX_INTERNAL_LIMIT && series.internalReview;
    const internal = withInternal ? await loadInternalViewForUi(series.repositoryFullName, series.issueNumber, true, series.internalStopReason) : null;
    fixes.push(fixView(series, internal, withInternal || !series.internalReview));
  }

  return ok({
    repository: target.repository,
    candidate: {
      sequence: candidate.sequence,
      phase: candidate.phase,
      active: candidate.activeKey !== null,
      currentRevision: candidate.currentRevision,
      frozenDevelopSha: candidate.frozenDevelopSha,
      cancelled: candidate.cancelledAt !== null,
      cancelReason: candidate.cancelReason,
      createdAt: candidate.createdAt.toISOString(),
    },
    revisions: {
      total: candidate.revisions.length > REVISION_LIMIT ? `>${REVISION_LIMIT}` : revisions.length,
      truncated: candidate.revisions.length > REVISION_LIMIT,
      items: revisions.map((r) => ({
        revision: r.revision,
        reason: r.reason,
        status: r.status,
        isCurrent: r.revision === candidate.currentRevision,
        prNumber: r.prNumber,
        baseSha: r.baseSha,
        headSha: r.headSha,
        expectedHeadSha: r.expectedHeadSha,
        fixSeriesId: r.fixSeriesId,
        failureReason: r.failureReason,
        appliedAt: r.appliedAt?.toISOString() ?? null,
      })),
    },
    currentTarget: current ? { revision: current.revision, prNumber: current.prNumber, baseSha: current.baseSha, headSha: current.headSha } : null,
    verification,
    verificationNotice: current ? null : "適用済みの現行revisionが無いため、現在有効な検証結果はありません（履歴のみ）",
    verificationHistory: { total: history.length, truncated: history.length > HISTORY_ROW_LIMIT, items: history.slice(0, HISTORY_ROW_LIMIT) },
    inheritance: candidate.finalizations.map((f) => ({
      status: f.status,
      prNumber: f.prNumber,
      preHeadSha: f.preHeadSha,
      finalHeadSha: f.finalHeadSha,
      evidence: f.handoffEvidence,
      appliedAt: f.appliedAt?.toISOString() ?? null,
    })),
    fixes: { total: seriesRows.length > FIX_LIMIT ? `>${FIX_LIMIT}` : seriesRows.length, truncated: seriesRows.length > FIX_LIMIT, items: fixes },
    notices: {
      semantics: "relation は current（現行の対象に対する結果）／stale_sha（旧SHAの結果。現在の合否に使わない）／inherited（バンプ前の合格を引き継いだ派生記録。inheritedFromHeadSha が元）",
    },
  });
}

function fixView(
  series: { issueNumber: number; releasePrNumber: number; generation: number; parentId: string | null; status: string; stopReason: string | null; sourceKind: string; causeClass: string; originHeadSha: string; fixPrNumber: number | null; fixPrMergedAt: Date | null; internalReview: boolean; items: unknown; successorPrNumber: number | null; successorHeadSha: string | null },
  internal: InternalStatusView | null,
  internalIncluded: boolean,
) {
  const items = Array.isArray(series.items) ? (series.items as unknown[]) : [];
  return {
    issueNumber: series.issueNumber,
    releasePrNumber: series.releasePrNumber,
    generation: series.generation,
    parentId: series.parentId,
    status: series.status,
    active: isReleaseFixActive(series.status),
    stopReason: series.stopReason,
    sourceKind: series.sourceKind,
    causeClass: series.causeClass,
    originHeadSha: series.originHeadSha,
    fixPrNumber: series.fixPrNumber,
    fixPrMergedAt: series.fixPrMergedAt?.toISOString() ?? null,
    successor: series.successorPrNumber ? { prNumber: series.successorPrNumber, headSha: series.successorHeadSha } : null,
    items: pageOf(items, 0, 20),
    internalReview: series.internalReview,
    internalIncluded,
    internal,
    nextAction: internal?.pause?.nextAction ?? internal?.gate.message ?? null,
  };
}

async function getFix(ctx: ToolContext, args: Args): Promise<ToolResult> {
  const target = await targetOf(ctx, args);
  if (isFailure(target)) return target;
  const issue = int(args.issue, 1, 1_000_000_000);
  if (issue === null) return fail(400, "invalid_request", "issue（修正Issue番号）を指定してください");
  const rows = await db.releaseFixSeries.findMany({ where: { repositoryFullName: target.repository, issueNumber: issue }, orderBy: { createdAt: "desc" }, take: 5 });
  const series = rows.find((r) => isReleaseFixActive(r.status)) ?? rows[0] ?? null;
  if (!series) return fail(404, "series_not_found", "この修正Issueに結び付いた修正系列がありません");
  const internal = series.internalReview ? await loadInternalViewForUi(series.repositoryFullName, series.issueNumber, true, series.internalStopReason) : null;
  return ok({ repository: target.repository, fix: fixView(series, internal, true), replaced: !isReleaseFixActive(series.status) });
}

// ------------------------------------------------------------------------------------------------ 更新

function mapWrite(result: { ok: true; status?: InternalStatusView; round?: number; epoch?: number; handover?: boolean } | InternalReportError): ToolResult {
  if (!result.ok) return fromInternalError(result);
  const { ok: _ok, ...rest } = result;
  return ok(rest);
}

async function writeTarget(ctx: ToolContext, args: Args): Promise<{ repository: string; issue: number; agent: string } | ToolFailure> {
  const target = await targetOf(ctx, args);
  if (isFailure(target)) return target;
  const issue = int(args.issue, 1, 1_000_000_000);
  const agent = agentName(ctx, args);
  if (issue === null || !agent) return fail(400, "invalid_request", "issue（修正Issue番号）と agent（英数字・._- の1〜60文字）を指定してください");
  return { repository: target.repository, issue, agent };
}

const epochOf = (args: Args) => (Number.isInteger(args.epoch) && (args.epoch as number) >= 0 ? (args.epoch as number) : null);
const shaOf = (args: Args) => (typeof args.sha === "string" && SHA_PATTERN.test(args.sha) ? args.sha : null);

const baseWriteProps = {
  repository: { type: "string", description: "owner/name" },
  issue: { type: "integer", description: "修正Issue番号" },
  agent: { type: "string", description: "このエージェントの識別名（英数字・._-、60文字以内）" },
  idempotencyKey: { type: "string", description: "再送しても二重に実行しないためのキー（8〜120文字。操作ごとに新しい値）" },
};

const TOOLS: ToolDefinition[] = [
  {
    name: "list_release_candidates",
    description: "リリース候補の一覧（新しい順）。各候補の現行revisionのPR・base/headを含む。ページングは page.nextCursor を cursor に渡す",
    scope: "read",
    inputSchema: { type: "object", properties: { repository: { type: "string", description: "owner/name" }, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "integer", description: "前の応答の page.nextCursor" } }, required: ["repository"] },
    run: listCandidates,
  },
  {
    name: "get_release_candidate",
    description: "リリース候補1件の全体レビュー・統合検証・修正状態。現行の結果と旧SHA・引き継ぎの結果を区別し、指摘はfindingsOffset/findingsLimitでページングする（truncated・total・nextOffsetで欠落を明示）。読み取りは副作用なし",
    scope: "read",
    inputSchema: { type: "object", properties: { repository: { type: "string" }, sequence: { type: "integer", description: "候補番号" }, findingsOffset: { type: "integer", minimum: 0 }, findingsLimit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["repository", "sequence"] },
    run: getCandidate,
  },
  {
    name: "get_fix_status",
    description: "修正Issue1件の内部確認の状態（未解決の指摘・往復・テスト・担当と世代番号epoch・一時停止の理由と次の操作）。報告前に必ず読み、epochと対象SHAを確かめる。読み取りは副作用なし",
    scope: "read",
    inputSchema: { type: "object", properties: { repository: { type: "string" }, issue: { type: "integer" } }, required: ["repository", "issue"] },
    run: getFix,
  },
  {
    name: "claim_fix",
    description: "修正の担当を取得する。別の担当が持ち時間内なら takeover=true で引き継ぐ。応答の epoch を以降の報告へ添える",
    scope: "write",
    inputSchema: { type: "object", properties: { ...baseWriteProps, takeover: { type: "boolean" } }, required: ["repository", "issue", "agent", "idempotencyKey"] },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "claim_fix", args, async (t) => mapWrite(await claimInternalSession({ repositoryFullName: t.repository, issueNumber: t.issue, assignee: t.agent, takeover: args.takeover === true }))),
  },
  {
    name: "release_fix",
    description: "担当を解放する（記録は保持。他のエージェントが続きを取得できる）",
    scope: "write",
    inputSchema: { type: "object", properties: { ...baseWriteProps, epoch: { type: "integer" } }, required: ["repository", "issue", "agent", "idempotencyKey", "epoch"] },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "release_fix", args, async (t) => mapWrite(await releaseInternalSession({ repositoryFullName: t.repository, issueNumber: t.issue, actor: { assignee: t.agent, epoch: epochOf(args) } }))),
  },
  {
    name: "pause_fix",
    description: "実行環境の障害（environment）・本人判断や権限の不足（needs_decision）で一時停止する。作業内容は保持される",
    scope: "write",
    inputSchema: { type: "object", properties: { ...baseWriteProps, epoch: { type: "integer" }, kind: { type: "string", enum: ["environment", "needs_decision"] }, detail: { type: "string" } }, required: ["repository", "issue", "agent", "idempotencyKey", "epoch", "kind"] },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "pause_fix", args, async (t) => {
        const kind = args.kind === "environment" || args.kind === "needs_decision" ? args.kind : null;
        if (!kind) return fail(400, "invalid_request", "kind は environment か needs_decision です");
        return mapWrite(await pauseInternalByReport({ repositoryFullName: t.repository, issueNumber: t.issue, kind, detail: str(args.detail, 500), actor: { assignee: t.agent, epoch: epochOf(args) } }));
      }),
  },
  {
    name: "resume_fix",
    description: "回復済みの実行環境障害による一時停止だけを、入力なしで再開する。予算の追加・方針が要る停止は画面から人が再開する。本番マージ・公開の承認は含まない",
    scope: "resume",
    inputSchema: { type: "object", properties: baseWriteProps, required: ["repository", "issue", "agent", "idempotencyKey"] },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "resume_fix", args, async (t) => mapWrite(await resumeInternal({ repositoryFullName: t.repository, issueNumber: t.issue, assignee: t.agent, by: t.agent, autoOnly: true }))),
  },
  {
    name: "report_fix_test",
    description: "必要テストの結果を報告する。sha には実際にテストした40桁のコミットSHAを渡す（ブランチの現在のHEADと違えば stale_sha で拒否し、最新HEADへ付け替えない）",
    scope: "write",
    inputSchema: { type: "object", properties: { ...baseWriteProps, epoch: { type: "integer" }, sha: { type: "string" }, state: { type: "string", enum: ["passed", "failed"] }, summary: { type: "string" } }, required: ["repository", "issue", "agent", "idempotencyKey", "epoch", "sha", "state"] },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "report_fix_test", args, async (t) => {
        const state = args.state === "passed" || args.state === "failed" ? args.state : null;
        const sha = shaOf(args);
        if (!state || !sha) return fail(400, "invalid_request", "state（passed/failed）と、40桁の sha が必要です");
        return mapWrite(await recordInternalTest({ repositoryFullName: t.repository, issueNumber: t.issue, state, summary: str(args.summary, 8000), expectedSha: sha, actor: { assignee: t.agent, epoch: epochOf(args) } }));
      }),
  },
  {
    name: "report_fix_review",
    description: "独立レビューの結果を報告する。**実装を担当した主体（同じトークン）のレビューは独立レビューとして受理しない**。sha は実際にレビューしたコミット、解消した指摘は resolved[].resolution に根拠が必須",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        ...baseWriteProps,
        epoch: { type: "integer", description: "get_fix_status の assignee.epoch（現在の担当の世代）" },
        sha: { type: "string" },
        verdict: { type: "string", enum: ["pass", "findings"] },
        summary: { type: "string" },
        newFindings: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] } },
        stillOpen: { type: "array", items: { type: "string" }, description: "未解消の指摘キー（F-001など）" },
        resolved: { type: "array", items: { type: "object", properties: { key: { type: "string" }, resolution: { type: "string" } }, required: ["key", "resolution"] } },
      },
      required: ["repository", "issue", "agent", "idempotencyKey", "epoch", "sha", "verdict"],
    },
    run: (ctx, args) =>
      writeWithIdempotency(ctx, "report_fix_review", args, async (t) => {
        const verdict = args.verdict === "pass" || args.verdict === "findings" ? args.verdict : null;
        const sha = shaOf(args);
        const epoch = epochOf(args);
        if (!verdict || !sha || epoch === null) return fail(400, "invalid_request", "verdict・40桁の sha・epoch が必要です");
        const newFindings = Array.isArray(args.newFindings)
          ? (args.newFindings as unknown[]).flatMap((x) => {
              const o = x as { title?: unknown; detail?: unknown } | null;
              return o && typeof o.title === "string" && o.title.trim() !== "" ? [{ title: o.title, detail: typeof o.detail === "string" ? o.detail : null }] : [];
            })
          : [];
        const resolved = Array.isArray(args.resolved)
          ? (args.resolved as unknown[]).flatMap((x) => {
              const o = x as { key?: unknown; resolution?: unknown } | null;
              return o && typeof o.key === "string" ? [{ key: o.key, resolution: typeof o.resolution === "string" ? o.resolution.trim() : "" }] : [];
            })
          : [];
        if (resolved.some((r) => r.resolution === "")) return fail(400, "invalid_request", "解消した指摘には、解消を確かめた根拠（resolution）が必要です");
        const stillOpen = Array.isArray(args.stillOpen) ? (args.stillOpen as unknown[]).filter((x): x is string => typeof x === "string") : [];
        return mapWrite(
          await recordInternalReview({
            repositoryFullName: t.repository,
            issueNumber: t.issue,
            report: { verdict, newFindings, stillOpen, resolved },
            summary: str(args.summary, 8000),
            expectedSha: sha,
            actor: { assignee: t.agent, epoch, reviewer: true },
            reviewer: { kind: "external", ref: t.agent, isSelf: isSelf(ctx) },
          }),
        );
      }),
  },
];

/**
 * 更新の共通処理。冪等キーで二重実行を止める: 同じキー・同じ内容の再送は保存した結果を返し、
 * 同じキーで内容が違えば拒否、実行中の再送は`in_progress`。**成功した結果だけを保存する**（拒否は取得し直して再送できる）。
 */
async function writeWithIdempotency(ctx: ToolContext, tool: string, args: Args, run: (t: { repository: string; issue: number; agent: string }) => Promise<ToolResult>): Promise<ToolResult> {
  const t = await writeTarget(ctx, args);
  if (isFailure(t)) return t;
  const key = typeof args.idempotencyKey === "string" && IDEM_PATTERN.test(args.idempotencyKey) ? args.idempotencyKey : null;
  if (!key) return fail(400, "invalid_request", "idempotencyKey（8〜120文字の英数字・._:-）が必要です");
  const { idempotencyKey: _k, ...payload } = args;
  const requestHash = createHash("sha256").update(JSON.stringify([tool, sortKeys(payload)])).digest("hex");

  const existing = await db.reviewAgentIdempotency.findUnique({ where: { tokenId_idemKey: { tokenId: ctx.principal.tokenId, idemKey: key } } });
  if (existing) return replayOf(existing, requestHash);
  try {
    await db.reviewAgentIdempotency.create({ data: { tokenId: ctx.principal.tokenId, idemKey: key, tool, requestHash } });
  } catch {
    const raced = await db.reviewAgentIdempotency.findUnique({ where: { tokenId_idemKey: { tokenId: ctx.principal.tokenId, idemKey: key } } });
    if (raced) return replayOf(raced, requestHash);
    throw new Error("idempotency insert failed");
  }
  let result: ToolResult;
  try {
    result = await run(t);
  } catch (error) {
    await db.reviewAgentIdempotency.deleteMany({ where: { tokenId: ctx.principal.tokenId, idemKey: key } });
    throw error;
  }
  if (result.ok) {
    await db.reviewAgentIdempotency.updateMany({ where: { tokenId: ctx.principal.tokenId, idemKey: key }, data: { response: result.data as object } });
    await db.reviewAgentToken.updateMany({ where: { id: ctx.principal.tokenId }, data: { lastUsedAt: new Date() } });
  } else {
    // 拒否は保存しない。状態を取り直して同じキーでも別のキーでも再送できる
    await db.reviewAgentIdempotency.deleteMany({ where: { tokenId: ctx.principal.tokenId, idemKey: key } });
  }
  return result;
}

function replayOf(row: { tool: string; requestHash: string; response: unknown }, requestHash: string): ToolResult {
  if (row.requestHash !== requestHash) {
    return fail(409, "idempotency_conflict", "同じ idempotencyKey が別の内容の操作に使われています。操作ごとに新しいキーを使ってください");
  }
  if (row.response === null || row.response === undefined) {
    return fail(409, "in_progress", "同じ操作がまだ実行中です。少し待って状態を取得し直してください", { refetchRequired: true });
  }
  return { ok: true, data: row.response, replayed: true };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

export function listReviewAgentTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope, inputSchema: t.inputSchema }));
}

/** ツール呼び出しの入口（RESTとMCPが共有）。操作範囲を確かめ、更新と拒否を監査へ残す */
export async function callReviewAgentTool(principal: ReviewAgentPrincipal, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return fail(404, "unknown_tool", `ツール ${name} はありません`);
  const args: Args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
  const repositoryFullName = typeof args.repository === "string" && REPOSITORY_PATTERN.test(args.repository) ? args.repository : null;
  const issueNumber = Number.isInteger(args.issue) ? (args.issue as number) : null;
  const audit = (outcome: "ok" | "rejected" | "denied", errorCode: string | null) => recordReviewAgentAudit({ principal, tool: name, repositoryFullName, issueNumber, outcome, errorCode });

  if (!principal.scopes.includes(tool.scope)) {
    await audit("denied", "scope_not_allowed");
    return fail(403, "scope_not_allowed", `このトークンには ${tool.scope} の操作範囲がありません`);
  }
  const result = await tool.run({ principal }, args);
  if (result.ok) {
    if (tool.scope !== "read") await audit("ok", null);
  } else {
    await audit(result.status === 403 ? "denied" : "rejected", result.error);
  }
  return result;
}
