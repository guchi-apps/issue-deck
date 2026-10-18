import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { fetchBaseAdvanceChangedFiles } from "@/lib/github/release-api";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import {
  assessDecisionBase,
  isNonFixDecision,
  parseReleaseReviewDecisionAction,
  summarizeReleaseReviewDecisions,
  type DecisionBaseContext,
  type DecisionTargetFinding,
  type ReleaseReviewDecisionAction,
  type ReleaseReviewDecisionRecord,
  type ReleaseReviewDecisionSummary,
} from "@/lib/release-review-decision";
import { parseReasonSource, type ReasonSource } from "@/lib/release-review-recommendation";

/**
 * 全体レビューの指摘ごとの判断（#4657）の読み書き。判定は`release-review-decision.ts`の純関数に委ねる。
 *
 * **判断の範囲（`scopeKey`）は候補系列。** 旧方式は作り直すと後継のPRになり、新方式（RC）はrevisionが進んでも
 * 同じPRのままなので、修正系列（`ReleaseFixSeries.successorPrNumber`）を遡った最初のリリースPRで束ねる。
 * 他の候補・他repoの判断は引かない。
 */

const MAX_CHAIN = 30;

/** 修正系列を遡った候補系列のPR番号（現在のPRを先頭に、古いものほど後ろ）。循環は止める */
export async function resolveReleaseDecisionChain(repoFullName: string, prNumber: number): Promise<number[]> {
  const chain = [prNumber];
  for (let cursor = prNumber; chain.length < MAX_CHAIN; ) {
    const parent = await db.releaseFixSeries.findFirst({
      where: { repositoryFullName: repoFullName, successorPrNumber: cursor },
      orderBy: { createdAt: "desc" },
      select: { releasePrNumber: true },
    });
    if (!parent || chain.includes(parent.releasePrNumber)) break;
    chain.push(parent.releasePrNumber);
    cursor = parent.releasePrNumber;
  }
  return chain;
}

export function releaseDecisionScopeKey(repoFullName: string, chain: readonly number[]): string {
  return `${repoFullName}#${chain[chain.length - 1]}`;
}

type DecisionRow = Prisma.ReleaseReviewDecisionGetPayload<object>;

function parseRecommendationSnapshot(r: DecisionRow): ReleaseReviewDecisionRecord["recommendation"] {
  const decision = parseReleaseReviewDecisionAction(r.recommendedDecision);
  if (!decision || decision === "withdrawn") return null;
  return { decision, reason: r.recommendedReason ?? "" };
}

async function toRecords(rows: readonly DecisionRow[]): Promise<ReleaseReviewDecisionRecord[]> {
  const userIds = [...new Set(rows.map((r) => r.decidedByUserId))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, githubLogin: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name ?? u.githubLogin]));
  return rows.flatMap((r) => {
    const decision = parseReleaseReviewDecisionAction(r.decision);
    if (!decision) return [];
    const severity = r.severity === "high" || r.severity === "low" ? r.severity : "medium";
    return [
      {
        id: r.id,
        findingId: r.findingId,
        sequence: r.sequence,
        decision,
        reason: r.reason,
        impact: r.impact,
        scope: r.scope,
        followUp: r.followUpRepo && r.followUpNumber ? { repo: r.followUpRepo, number: r.followUpNumber } : null,
        timing: r.timing,
        prNumber: r.prNumber,
        headRef: r.headRef,
        baseSha: r.baseSha,
        headSha: r.headSha,
        severity,
        blocking: r.blocking,
        findingTitle: r.findingTitle,
        decidedBy: names.get(r.decidedByUserId) ?? "不明なユーザー",
        decidedAt: r.createdAt.toISOString(),
        recommendation: parseRecommendationSnapshot(r),
        reasonSource: parseReasonSource(r.reasonSource),
      },
    ];
  });
}

export async function listReleaseReviewDecisions(scopeKey: string): Promise<ReleaseReviewDecisionRecord[]> {
  const rows = await db.releaseReviewDecision.findMany({ where: { scopeKey }, orderBy: [{ findingId: "asc" }, { sequence: "asc" }], take: 2000 });
  return toRecords(rows);
}

/** 一度に照合する判断時のbaseの上限。超えた分は確かめられないものとして判断を無効にする */
const MAX_BASE_COMPARES = 5;
/**
 * 2つのSHAの間の変更は変わらないので、比較できた結果を覚えておく（画面の再読み込みのたびにGitHubを引かない）。
 * 書き換え・上限超過で確かめられない結果（null）も同じSHAの組では変わらないので覚える。取得の失敗（例外）は覚えない
 */
const baseChangesCache = new Map<string, readonly string[] | null>();
const BASE_CHANGES_CACHE_LIMIT = 200;

/**
 * 判断時のbaseごとに、現在のbaseまでに変わったファイルを取る（#4766）。取れなかったbaseはnull
 * （トークンが無い・比較に失敗した・mainが書き換えられた）で、判定側は判断を無効にする
 */
export async function loadDecisionBaseChanges(
  repoFullName: string,
  recordBaseShas: readonly string[],
  currentBaseSha: string,
): Promise<Record<string, readonly string[] | null>> {
  const bases = [...new Set(recordBaseShas)].filter((sha) => sha !== currentBaseSha);
  const result: Record<string, readonly string[] | null> = {};
  if (bases.length === 0) return result;
  const [owner, repo] = repoFullName.split("/");
  let token: string | null | undefined;
  let fetched = 0;
  for (const from of bases) {
    const cacheKey = `${repoFullName}:${from}...${currentBaseSha}`;
    if (baseChangesCache.has(cacheKey)) {
      result[from] = baseChangesCache.get(cacheKey) ?? null;
      continue;
    }
    if (fetched >= MAX_BASE_COMPARES) {
      result[from] = null;
      continue;
    }
    fetched += 1;
    try {
      token ??= await resolveInstallationToken(repoFullName);
      if (!token) {
        result[from] = null;
        continue;
      }
      const files = await fetchBaseAdvanceChangedFiles(owner, repo, from, currentBaseSha, token);
      result[from] = files;
      if (baseChangesCache.size >= BASE_CHANGES_CACHE_LIMIT) baseChangesCache.delete(baseChangesCache.keys().next().value as string);
      baseChangesCache.set(cacheKey, files);
    } catch (error) {
      console.error("[release-review-decision] base compare failed", repoFullName, from, currentBaseSha, error);
      result[from] = null;
    }
  }
  return result;
}

/** 撤回されていない最新の判断の、判断時のbase（照合が要るものだけを取るため） */
function latestDecisionBases(records: readonly { findingId: string; sequence: number; decision: string; baseSha: string }[]): string[] {
  const latest = new Map<string, (typeof records)[number]>();
  for (const r of records) {
    const prev = latest.get(r.findingId);
    if (!prev || r.sequence > prev.sequence) latest.set(r.findingId, r);
  }
  return [...latest.values()].filter((r) => r.decision !== "withdrawn").map((r) => r.baseSha);
}

/** 判断の有効性を決める現在の対象を、保存済みの判断から組み立てる（#4766） */
export async function loadDecisionBaseContext(
  repoFullName: string,
  records: readonly { findingId: string; sequence: number; decision: string; baseSha: string }[],
  baseSha: string,
): Promise<DecisionBaseContext> {
  return { baseSha, baseChanges: await loadDecisionBaseChanges(repoFullName, latestDecisionBases(records), baseSha) };
}

/** リリースPRの現在の結果に対する判断の要約。DBの表が無い・読めないときはnull（判断なしと同じ扱い） */
export async function loadReleaseReviewDecisionSummary(input: {
  repoFullName: string;
  prNumber: number;
  current: { baseSha: string };
  findings: readonly DecisionTargetFinding[];
  suggestions: readonly DecisionTargetFinding[];
  state: string;
  unverifiedScope: string | null;
}): Promise<ReleaseReviewDecisionSummary | null> {
  try {
    const chain = await resolveReleaseDecisionChain(input.repoFullName, input.prNumber);
    const records = await listReleaseReviewDecisions(releaseDecisionScopeKey(input.repoFullName, chain));
    const current = await loadDecisionBaseContext(input.repoFullName, records, input.current.baseSha);
    return summarizeReleaseReviewDecisions({ ...input, current, records });
  } catch (error) {
    console.error("[release-review-decision] load failed", input.repoFullName, input.prNumber, error);
    return null;
  }
}

/**
 * 修正系列の巡回用。指摘の本文を読まずに、**今のbaseで有効な**非修正の判断（公開後対応・見送り・不採用）が付いた指摘IDを返す。
 * `files`は指摘ID（旧IDを含む）→対象ファイル。判断時からmainが進んでいれば、そのファイルが変わっていないときだけ有効（#4766）。
 * 重大度の上昇・前提変化の報告は結果を読む経路（`loadReleaseReviewDecisionSummary`）が判定する。読めなければ空（判断なしと同じ）
 */
export async function loadNonFixFindingIds(
  repoFullName: string,
  prNumber: number,
  target: { baseSha: string; files: Readonly<Record<string, string | null>> },
): Promise<Set<string>> {
  try {
    const chain = await resolveReleaseDecisionChain(repoFullName, prNumber);
    const rows = await db.releaseReviewDecision.findMany({
      where: { scopeKey: releaseDecisionScopeKey(repoFullName, chain) },
      orderBy: { sequence: "asc" },
      select: { findingId: true, decision: true, baseSha: true, sequence: true },
      take: 2000,
    });
    const current = await loadDecisionBaseContext(repoFullName, rows, target.baseSha);
    const latest = new Map<string, { decision: string; baseSha: string }>();
    for (const row of rows) latest.set(row.findingId, row);
    const ids = new Set<string>();
    for (const [id, row] of latest) {
      if (!isNonFixDecision(parseReleaseReviewDecisionAction(row.decision))) continue;
      if (assessDecisionBase(row.baseSha, target.files[id] ?? null, current) === null) ids.add(id);
    }
    return ids;
  } catch (error) {
    console.error("[release-review-decision] non-fix lookup failed", repoFullName, prNumber, error);
    return new Set();
  }
}

export type SaveDecisionInput = {
  scopeKey: string;
  repoFullName: string;
  findingId: string;
  /** 同じ指摘の判断として読んでいる別のID（旧IDで保存された判断。#4766）。最新の判断の確認に含める */
  aliasIds?: readonly string[];
  /** 画面が見ていた最新の判断ID（未判断ならnull）。今の最新と違えば保存しない */
  expectedDecisionId: string | null;
  decision: ReleaseReviewDecisionAction;
  reason: string;
  impact: string | null;
  scope: string | null;
  followUp: { repo: string; number: number } | null;
  timing: string | null;
  prNumber: number;
  headRef: string;
  baseSha: string;
  headSha: string;
  severity: string;
  blocking: boolean;
  findingTitle: string;
  userId: string;
  /** 判断時に表示していたAIの推奨（#4676）。推奨を見ずに判断したときはnull */
  recommendation?: { id: string; decision: string; reason: string } | null;
  reasonSource?: ReasonSource;
};

export type SaveDecisionResult =
  | { ok: true; record: ReleaseReviewDecisionRecord }
  | { ok: false; error: "decision_conflict"; latest: ReleaseReviewDecisionRecord | null };

/**
 * 判断を1件追記する。**直前の判断を見ないまま保存した操作（同時判断・古い画面）は`decision_conflict`で止める**。
 * 最新の通し番号の確認と追記の間に別の保存が入った場合も、通し番号の一意制約で失敗させる（黙って上書きしない）
 */
export async function saveReleaseReviewDecision(input: SaveDecisionInput): Promise<SaveDecisionResult> {
  const latestRow = await db.releaseReviewDecision.findFirst({
    where: { scopeKey: input.scopeKey, findingId: input.findingId },
    orderBy: { sequence: "desc" },
  });
  // 旧IDで保存された判断も同じ指摘の判断として読むので、最新の確認はそれらを含めた判断時刻で行う（#4766）
  const ids = [...new Set([input.findingId, ...(input.aliasIds ?? [])])];
  const latestAny = async () =>
    ids.length === 1
      ? db.releaseReviewDecision.findFirst({ where: { scopeKey: input.scopeKey, findingId: input.findingId }, orderBy: { sequence: "desc" } })
      : db.releaseReviewDecision.findFirst({
          where: { scopeKey: input.scopeKey, findingId: { in: ids } },
          orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
        });
  const currentLatest = ids.length === 1 ? latestRow : await latestAny();
  const conflict = async () => {
    const row = await latestAny();
    return { ok: false as const, error: "decision_conflict" as const, latest: row ? ((await toRecords([row]))[0] ?? null) : null };
  };
  if ((currentLatest?.id ?? null) !== input.expectedDecisionId) return conflict();
  if (input.decision === "withdrawn" && (!currentLatest || currentLatest.decision === "withdrawn")) return conflict();
  try {
    const row = await db.releaseReviewDecision.create({
      data: {
        scopeKey: input.scopeKey,
        repoFullName: input.repoFullName,
        findingId: input.findingId,
        sequence: (latestRow?.sequence ?? 0) + 1,
        decision: input.decision,
        reason: input.reason.slice(0, 2000),
        impact: input.impact?.slice(0, 2000) ?? null,
        scope: input.scope?.slice(0, 2000) ?? null,
        followUpRepo: input.followUp?.repo ?? null,
        followUpNumber: input.followUp?.number ?? null,
        timing: input.timing?.slice(0, 500) ?? null,
        prNumber: input.prNumber,
        headRef: input.headRef.slice(0, 191),
        baseSha: input.baseSha,
        headSha: input.headSha,
        severity: input.severity.slice(0, 16),
        blocking: input.blocking,
        findingTitle: input.findingTitle.slice(0, 300),
        decidedByUserId: input.userId,
        recommendationId: input.recommendation?.id.slice(0, 40) ?? null,
        recommendedDecision: input.recommendation?.decision.slice(0, 32) ?? null,
        recommendedReason: input.recommendation?.reason.slice(0, 2000) ?? null,
        reasonSource: input.reasonSource ?? null,
      },
    });
    return { ok: true, record: (await toRecords([row]))[0] };
  } catch (error) {
    if (isUniqueConstraintError(error)) return conflict();
    throw error;
  }
}
