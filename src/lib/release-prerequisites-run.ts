import { db } from "@/lib/db";
import { evaluateReleasePrerequisites, type PlanForRelease, type ReleasePrerequisiteBlocker } from "@/lib/execution-plan/release-link";
import { refKey, type PlanSnapshot } from "@/lib/execution-plan/types";
import { defaultDeps, observeRef, type Deps } from "@/lib/parent-run/run";
import type { RefObservation } from "@/lib/parent-run/decide";
import { findCandidateIdByPullRequest } from "@/lib/release-rc-run";

/**
 * 候補の公開前に終わっていないpre-releaseの前提を集める（#4523。IOを持つ側）。判定は`release-link.ts`の純関数。
 *
 * 候補は新方式（`release-rc/<番号>`）の`ReleaseCandidate`から引く。**旧方式（`release-main/*`）は
 * 候補の機能を引けないため前提を返さない**（従来どおり検証ゲートだけで進む）。
 * 取得に失敗した参照は`observeRef`が`error`として残し、判定は成立とせず「取得失敗」で止める。
 */

function numbersOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const n = (v as { number?: unknown } | null)?.number;
    return typeof n === "number" && Number.isInteger(n) ? [n] : [];
  });
}

export async function loadCandidatePrNumbers(repositoryFullName: string, prNumber: number): Promise<number[] | null> {
  const candidateId = await findCandidateIdByPullRequest(repositoryFullName, prNumber);
  if (!candidateId) return null;
  const row = await db.releaseCandidate.findUnique({
    where: { id: candidateId },
    select: { frozenPrs: true, approvedExtraPrs: true, revisions: { where: { status: "applied" }, select: { importedPrs: true } } },
  });
  if (!row) return null;
  return [...new Set([...numbersOf(row.frozenPrs), ...numbersOf(row.approvedExtraPrs), ...row.revisions.flatMap((r) => numbersOf(r.importedPrs))])];
}

/** pre-release区分の子を持つ計画だけを集める。実行が結びついた版（無ければ最新の版）を使う */
async function loadPlansWithPreRelease(): Promise<PlanForRelease[]> {
  const rows = await db.executionPlan.findMany({ include: { versions: true } });
  const result: PlanForRelease[] = [];
  for (const row of rows) {
    const version = row.versions.find((v) => v.version === (row.boundVersion ?? row.currentVersion));
    if (!version) continue;
    const plan = version.snapshot as PlanSnapshot;
    if (!plan.children.some((c) => c.timing === "pre-release")) continue;
    const run = await db.parentRun.findFirst({
      where: { parentRepository: row.parentRepository, parentIssue: row.parentIssue },
      orderBy: { createdAt: "desc" },
      include: { children: true },
    });
    const verifiedAt = new Map<string, Date | null>((run?.children ?? []).map((c) => [`${c.repository}#${c.number}`, c.verifiedAt]));
    result.push({ parent: { repository: row.parentRepository, number: row.parentIssue }, plan, verifiedAt });
  }
  return result;
}

export async function loadReleasePrerequisiteBlockers(
  repositoryFullName: string,
  candidatePrNumber: number,
  deps: Deps = defaultDeps,
): Promise<ReleasePrerequisiteBlocker[]> {
  const prNumbers = await loadCandidatePrNumbers(repositoryFullName, candidatePrNumber);
  if (!prNumbers || prNumbers.length === 0) return [];
  const plans = await loadPlansWithPreRelease();
  if (plans.length === 0) return [];
  const observations = new Map<string, RefObservation>();
  await Promise.all(
    plans.flatMap((p) =>
      p.plan.children.map(async (child) => {
        const key = refKey(child);
        if (!observations.has(key)) observations.set(key, await observeRef(child, undefined, deps));
      }),
    ),
  );
  return evaluateReleasePrerequisites({ candidateRepository: repositoryFullName, candidatePrNumbers: prNumbers, plans, observations });
}
