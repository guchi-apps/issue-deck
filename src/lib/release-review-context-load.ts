import { db } from "@/lib/db";
import type { ReleaseReviewCheckStatus } from "@/lib/release-review-checklist";
import {
  buildReviewPromptContext,
  type PreviousReviewRecord,
  type ReleaseFixHistory,
  type ReleaseReviewPromptContext,
} from "@/lib/release-review-context";
import { buildFindingIdIndex, reviewFindingId, type ReleaseReviewContextFinding } from "@/lib/release-review-result";
import { assessDecisionBase } from "@/lib/release-review-decision";
import {
  listReleaseReviewDecisions,
  loadDecisionBaseContext,
  releaseDecisionScopeKey,
  resolveReleaseDecisionChain,
} from "@/lib/release-review-decision-store";
import type { ReleaseReviewContextDecision } from "@/lib/release-review-context";
import type { ReleaseVerificationTarget } from "@/lib/release-verification";

/**
 * 全体レビューの再レビュー文脈をDBから組み立てる（#4559）。ランナー向けのAPIと、結果の記録時の
 * 正規化の両方が使う。**記録時はランナーの申告ではなく、ここで取り直した値で引き継ぎの可否を決める**。
 */

const FINISHED_STATES = ["passed", "needs_check", "failed"];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readPrevious(row: {
  prNumber: number;
  baseSha: string;
  headSha: string;
  state: string;
  findings: unknown;
  unverifiedScope: string | null;
}): PreviousReviewRecord {
  const detail = (typeof row.findings === "object" && row.findings !== null ? row.findings : {}) as Record<string, unknown>;
  const review = (typeof detail.review === "object" && detail.review !== null ? detail.review : {}) as Record<string, unknown>;
  const checkStatuses: Record<string, ReleaseReviewCheckStatus> = {};
  for (const c of Array.isArray(review.checks) ? review.checks : []) {
    const rec = c as Record<string, unknown>;
    if (typeof rec?.id === "string" && (rec.status === "confirmed" || rec.status === "not_applicable" || rec.status === "unconfirmed")) {
      checkStatuses[rec.id] = rec.status;
    }
  }
  const findings = (Array.isArray(detail.findings) ? detail.findings : []).flatMap((f) => {
    const rec = f as Record<string, unknown>;
    const title = str(rec?.title);
    if (!title) return [];
    const file = str(rec.file);
    const line = typeof rec.line === "number" ? rec.line : null;
    return [
      {
        id: str(rec.id) ?? reviewFindingId({ title, file, line }),
        title,
        file,
        line,
        detail: str(rec.detail) ?? "",
        occurrences: typeof rec.occurrences === "number" && rec.occurrences > 0 ? rec.occurrences : 1,
      },
    ];
  });
  return {
    prNumber: row.prNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    state: row.state,
    checklistVersion: typeof review.checklistVersion === "number" ? review.checklistVersion : null,
    checkStatuses,
    findings,
    unverifiedScope: row.unverifiedScope,
  };
}

export async function loadReleaseReviewContext(target: ReleaseVerificationTarget): Promise<ReleaseReviewPromptContext> {
  const series = await db.releaseFixSeries.findMany({
    where: {
      repositoryFullName: target.repoFullName,
      OR: [{ successorPrNumber: target.prNumber }, { releasePrNumber: target.prNumber }],
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const prNumbers = [...new Set([target.prNumber, ...series.map((s) => s.releasePrNumber)])];
  const rows = await db.releaseVerification.findMany({
    where: {
      repoFullName: target.repoFullName,
      kind: "ai_review",
      prNumber: { in: prNumbers },
      state: { in: FINISHED_STATES },
      NOT: { prNumber: target.prNumber, headSha: target.headSha },
    },
    orderBy: { updatedAt: "desc" },
    take: 1,
  });
  const previous = rows[0] ? readPrevious(rows[0]) : null;

  const histories: ReleaseFixHistory[] = [];
  if (previous) {
    for (const s of series.filter((x) => x.releasePrNumber === previous.prNumber)) {
      const fixFindings = await db.releaseFixFinding.findMany({
        where: { repositoryFullName: target.repoFullName, issueNumber: s.issueNumber },
        orderBy: { key: "asc" },
        take: 50,
      });
      const items = (Array.isArray(s.items) ? s.items : []).flatMap((i) => {
        const rec = i as Record<string, unknown>;
        const title = str(rec?.title);
        return title ? [{ title, file: str(rec.file), detail: str(rec.detail) }] : [];
      });
      histories.push({
        issueNumber: s.issueNumber,
        fixPrNumber: s.fixPrNumber,
        status: s.status,
        items,
        findings: fixFindings.map((f) => ({
          key: f.key,
          title: f.title,
          status: f.status,
          resolution: f.resolution,
          reopenCount: f.reopenCount,
        })),
      });
    }
  }
  return buildReviewPromptContext({
    current: target,
    previous,
    histories,
    decisions: await loadContextDecisions(target, previous?.findings ?? []),
  });
}

/**
 * 候補系列のユーザー判断（#4657）。撤回されていない最新の判断だけ。読めなければ空（判断なしと同じ）。
 * mainが進んだ判断は、前回の指摘から引いた対象ファイルがその間に変わったときだけ前提の確認し直しにする（#4766）
 */
async function loadContextDecisions(
  target: ReleaseVerificationTarget,
  previousFindings: readonly ReleaseReviewContextFinding[],
): Promise<ReleaseReviewContextDecision[]> {
  try {
    const chain = await resolveReleaseDecisionChain(target.repoFullName, target.prNumber);
    const records = await listReleaseReviewDecisions(releaseDecisionScopeKey(target.repoFullName, chain));
    const current = await loadDecisionBaseContext(target.repoFullName, records, target.baseSha);
    const previousIndex = buildFindingIdIndex(previousFindings);
    const latest = new Map<string, (typeof records)[number]>();
    for (const r of records) {
      const prev = latest.get(r.findingId);
      if (!prev || r.sequence > prev.sequence) latest.set(r.findingId, r);
    }
    return [...latest.values()].flatMap((r) =>
      r.decision === "withdrawn"
        ? []
        : [
            {
              id: r.findingId,
              title: r.findingTitle,
              decision: r.decision,
              reason: r.reason,
              impact: r.impact,
              scope: r.scope,
              timing: r.timing,
              followUp: r.followUp ? `${r.followUp.repo}#${r.followUp.number}` : null,
              stale: assessDecisionBase(r.baseSha, previousIndex.get(r.findingId)?.file ?? null, current) !== null,
            },
          ],
    );
  } catch (error) {
    console.error("[release-review-context] decisions load failed", target.repoFullName, target.prNumber, error);
    return [];
  }
}
