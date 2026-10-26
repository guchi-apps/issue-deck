import { db } from "@/lib/db";
import { PRODUCTION_STOP_TEXT, parseProductionStopReason } from "@/lib/release-production-stop";
import { toPublishApprovalView } from "@/lib/release-publish-approval-run";
import type { ReleaseRcFacts } from "@/types/pull-request";

/**
 * 工程の表示（#5076。`release-journey.ts`）に渡す、新方式の候補の記録を読む。**DBだけを引き、GitHub APIは使わない**
 * （PR一覧の10秒間隔の取得に相乗りするため）。判定はしない。記録の語をそのまま`ReleaseRcFacts`へ詰める。
 *
 * 読めなかったときは例外をそのまま投げる。呼び出し側が「取得不能」の印（`unavailableParts`）へ変え、
 * 記録が無い候補（旧方式）と取り違えない
 */

type CandidateRow = Awaited<ReturnType<typeof findCandidates>>[number];

function findCandidates(ids: string[]) {
  return db.releaseCandidate.findMany({
    where: { id: { in: ids } },
    include: {
      revisions: { orderBy: { revision: "asc" } },
      publishApprovals: { orderBy: { createdAt: "desc" }, take: 1 },
      finalizations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

const factsKey = (repositoryFullName: string, number: number) => `${repositoryFullName}#${number}`;

/**
 * 候補行を`ReleaseRcFacts`へ詰める。キーは`<repo>#<PR番号>`。`keyWithoutPullRequest`なら、PRがまだ無い候補を
 * `<repo>#0`でも引けるようにする
 */
async function buildFacts(rows: CandidateRow[], options: { keyWithoutPullRequest?: boolean } = {}): Promise<Map<string, ReleaseRcFacts>> {
  const runIds = rows.flatMap((row) => row.publishApprovals[0]?.completionRunId ?? []);
  const runs = runIds.length > 0 ? await db.releaseCompletionRun.findMany({ where: { id: { in: runIds } } }) : [];
  // 作り直しの元（直前の番号で取り消された候補）。この候補の進捗には数えず、注記だけに使う
  const predecessors = rows.length > 0
    ? await db.releaseCandidate.findMany({
        where: { OR: rows.map((row) => ({ repositoryFullName: row.repositoryFullName, sequence: row.sequence - 1 })), phase: "cancelled" },
        select: { repositoryFullName: true, sequence: true, cancelReason: true },
      })
    : [];

  const result = new Map<string, ReleaseRcFacts>();
  for (const row of rows) {
    const approvalRow = row.publishApprovals[0] ?? null;
    const run = approvalRow?.completionRunId ? (runs.find((r) => r.id === approvalRow.completionRunId) ?? null) : null;
    const approval = approvalRow ? toPublishApprovalView(approvalRow, run, row.phase) : null;
    const finalization = row.finalizations[0] ?? null;
    const pending = row.revisions.find((r) => r.status === "requested") ?? null;
    const stopReason = parseProductionStopReason(row.productionStopReason);
    const predecessor = predecessors.find((p) => p.repositoryFullName === row.repositoryFullName && p.sequence === row.sequence - 1) ?? null;
    const updatedAt = [row.updatedAt, approvalRow?.updatedAt, run?.updatedAt, finalization?.updatedAt, ...row.revisions.map((r) => r.updatedAt)]
      .filter((d): d is Date => d instanceof Date)
      .reduce((a, b) => (a > b ? a : b));
    const appliedRevisions = row.revisions.filter((r) => r.status === "applied");
    const latestApplied = appliedRevisions.at(-1) ?? null;
    const finalHeadSha = finalization?.status === "applied" ? finalization.finalHeadSha : null;
    const facts: ReleaseRcFacts = {
      sequence: row.sequence,
      phase: row.phase,
      pendingRevision: pending ? { revision: pending.revision, reason: pending.reason } : null,
      approval: approval
        ? {
            status: approval.status,
            progress: approval.progress,
            approvedAt: approval.approvedAt,
            revision: approval.revision,
            invalidMessage: approval.invalidMessage,
            runStatus: approval.run?.status ?? null,
            runActive: approval.run?.active ?? false,
            waitMessage: approval.run?.waitMessage ?? null,
            waitStalled: approval.run?.waitStalled ?? false,
            stopMessage: approval.run?.stopMessage ?? null,
          }
        : null,
      finalization: finalization
        ? { status: finalization.status, failureReason: finalization.failureReason, updatedAt: finalization.updatedAt.toISOString() }
        : null,
      productionStopLabel: stopReason ? PRODUCTION_STOP_TEXT[stopReason].label : null,
      predecessor: predecessor ? { sequence: predecessor.sequence, cancelReason: predecessor.cancelReason } : null,
      importedPrs: appliedRevisions.flatMap((r) =>
        (Array.isArray(r.importedPrs) ? (r.importedPrs as { number?: unknown }[]) : []).flatMap((p) =>
          typeof p.number === "number" ? [{ number: p.number, revision: r.revision }] : [],
        ),
      ),
      currentHeadShas: [latestApplied?.headSha, finalHeadSha].filter((sha): sha is string => !!sha),
      updatedAt: updatedAt.toISOString(),
    };
    // 候補はrevisionごとに物理PRが変わりうる（バンプ前後・置換）。どのPR番号からも同じ候補へ引けるようにする
    for (const prNumber of new Set(row.revisions.flatMap((r) => r.prNumber ?? []))) {
      result.set(factsKey(row.repositoryFullName, prNumber), facts);
    }
    if (options.keyWithoutPullRequest) result.set(factsKey(row.repositoryFullName, 0), facts);
  }
  return result;
}

/** 開いたリリースPRごとの候補の記録。キーは`<repo>#<番号>`。記録の無いPR（旧方式）はMapに入らない */
export async function loadReleaseRcFacts(
  targets: readonly { repositoryFullName: string; number: number }[],
): Promise<Map<string, ReleaseRcFacts>> {
  if (targets.length === 0) return new Map();
  const revisions = await db.releaseCandidateRevision.findMany({
    where: { OR: targets.map((t) => ({ prNumber: t.number, candidate: { repositoryFullName: t.repositoryFullName } })) },
    select: { candidateId: true },
  });
  const ids = [...new Set(revisions.map((r) => r.candidateId))];
  if (ids.length === 0) return new Map();
  return buildFacts(await findCandidates(ids));
}

/**
 * 開いたPRに載らない候補（リポジトリごとに最新の1件）。作成を受け付けてPRができるまでの間と、mainへマージした後の
 * 本番反映・稼働確認の間が該当する。PR一覧の`releaseChecks`には載らないので、ブランチ画面が同じ候補として
 * 工程を追うために使う（#5076）。PRがまだ無い候補の`prNumber`はnull
 */
export async function loadDetachedRcFacts(
  repositoryFullNames: readonly string[],
): Promise<Map<string, { prNumber: number | null; facts: ReleaseRcFacts }>> {
  if (repositoryFullNames.length === 0) return new Map();
  const rows = await db.releaseCandidate.findMany({
    where: { repositoryFullName: { in: [...repositoryFullNames] }, phase: { in: ["creating", "deploying", "verifying_production"] } },
    select: { id: true, repositoryFullName: true },
    orderBy: { sequence: "desc" },
  });
  const latest = repositoryFullNames.flatMap((name) => rows.find((row) => row.repositoryFullName === name) ?? []);
  if (latest.length === 0) return new Map();
  const candidates = await findCandidates(latest.map((row) => row.id));
  const facts = await buildFacts(candidates, { keyWithoutPullRequest: true });
  const result = new Map<string, { prNumber: number | null; facts: ReleaseRcFacts }>();
  for (const candidate of candidates) {
    const prNumber = candidate.revisions.find((r) => r.revision === candidate.currentRevision && r.status === "applied")?.prNumber ?? null;
    const value = facts.get(factsKey(candidate.repositoryFullName, prNumber ?? 0));
    if (value) result.set(candidate.repositoryFullName, { prNumber, facts: value });
  }
  return result;
}
