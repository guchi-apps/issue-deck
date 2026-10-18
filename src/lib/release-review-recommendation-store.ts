import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { parseReleaseReviewDecisionAction } from "@/lib/release-review-decision";
import {
  RECOMMENDATION_BATCH_SIZE,
  parseStoredDrafts,
  type RecommendationTarget,
  type ReleaseReviewRecommendation,
  type ReleaseReviewRecommendationsView,
} from "@/lib/release-review-recommendation";

/**
 * 全体レビューの指摘ごとのAIの推奨（#4676）の読み書き。**推奨は対象（base・head）ごと**に1行で、
 * 対象が変わったら作り直す（古い対象の推奨を新しい対象へ使わない）。AIの原判定（重大度・止めるか）が
 * 変わった指摘も作り直す。取得に失敗した指摘は`failed`で残し、画面を開くたびにAIを呼び直さない。
 */

type RecommendationRow = Prisma.ReleaseReviewRecommendationGetPayload<object>;

export type RecommendationTargetKey = { scopeKey: string; baseSha: string; headSha: string };

function toRecommendation(row: RecommendationRow): ReleaseReviewRecommendation | null {
  const recommended = parseReleaseReviewDecisionAction(row.recommended);
  const drafts = parseStoredDrafts(row.drafts);
  if (row.status !== "ready" || !recommended || recommended === "withdrawn" || !drafts || !row.rationale) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    recommended,
    rationale: row.rationale,
    drafts,
    missing: Array.isArray(row.missing) ? row.missing.filter((m): m is string => typeof m === "string") : [],
    createdAt: row.createdAt.toISOString(),
  };
}

/** 推奨1件を、今の対象・今の原判定に対して使えるかを確かめて読む（判断APIの確定時に使う） */
export async function findUsableRecommendation(
  id: string,
  key: RecommendationTargetKey & { findingId: string },
): Promise<ReleaseReviewRecommendation | null> {
  const row = await db.releaseReviewRecommendation.findUnique({ where: { id } });
  if (
    !row ||
    row.scopeKey !== key.scopeKey ||
    row.baseSha !== key.baseSha ||
    row.headSha !== key.headSha ||
    row.findingId !== key.findingId
  ) {
    return null;
  }
  return toRecommendation(row);
}

/**
 * 対象の指摘の推奨を返す。保存済みで原判定が変わっていないものはそのまま、無い（または`retry`で失敗した）ものは
 * `generate`で作って保存する。`generate`が投げたら、その束の指摘を失敗として残す
 */
export async function loadOrGenerateRecommendations(input: {
  key: RecommendationTargetKey;
  repoFullName: string;
  prNumber: number;
  targets: readonly RecommendationTarget[];
  retry: boolean;
  generate: ((targets: RecommendationTarget[]) => Promise<{
    model: string | null;
    byFinding: Map<string, Omit<ReleaseReviewRecommendation, "id" | "findingId" | "baseSha" | "headSha" | "createdAt">>;
  }>) | null;
}): Promise<ReleaseReviewRecommendationsView> {
  const { key } = input;
  const view: ReleaseReviewRecommendationsView = { status: input.generate ? "ready" : "unavailable", byFinding: {}, failures: {} };
  if (input.targets.length === 0) return view;
  const rows = await db.releaseReviewRecommendation.findMany({
    where: { ...key, findingId: { in: input.targets.map((t) => t.id) } },
  });
  const rowById = new Map(rows.map((r) => [r.findingId, r]));
  const pending: RecommendationTarget[] = [];
  for (const target of input.targets) {
    const row = rowById.get(target.id);
    const sameJudgement = row && row.severity === target.severity && row.blocking === target.blocking;
    if (row && sameJudgement && row.status === "ready") {
      const rec = toRecommendation(row);
      if (rec) {
        view.byFinding[target.id] = rec;
        continue;
      }
    }
    if (row && sameJudgement && row.status === "failed" && !input.retry) {
      view.failures[target.id] = row.error ?? "AIの推奨を取得できませんでした";
      continue;
    }
    pending.push(target);
  }
  if (pending.length === 0) return view;
  if (!input.generate) {
    for (const t of pending) view.failures[t.id] = "この環境ではAIの推奨を使えません";
    return view;
  }

  for (let i = 0; i < pending.length; i += RECOMMENDATION_BATCH_SIZE) {
    const batch = pending.slice(i, i + RECOMMENDATION_BATCH_SIZE);
    let generated: Awaited<ReturnType<NonNullable<typeof input.generate>>> | null = null;
    let error: string | null = null;
    try {
      generated = await input.generate(batch);
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : "AIの推奨を取得できませんでした";
    }
    for (const target of batch) {
      const rec = generated?.byFinding.get(target.id) ?? null;
      const data = rec
        ? {
            status: "ready",
            recommended: rec.recommended,
            rationale: rec.rationale,
            drafts: rec.drafts as unknown as Prisma.InputJsonValue,
            missing: rec.missing as unknown as Prisma.InputJsonValue,
            error: null,
          }
        : { status: "failed", recommended: null, rationale: null, error: error ?? "AIの応答を読み取れませんでした" };
      const common = { severity: target.severity, blocking: target.blocking, model: generated?.model?.slice(0, 100) ?? null };
      const where = { scopeKey_baseSha_headSha_findingId: { ...key, findingId: target.id } };
      // 同じ対象を2つの画面が同時に開くと、作成が競合しうる。負けた側は先に保存された行を使う
      const row = await db.releaseReviewRecommendation
        .upsert({
          where,
          create: { ...key, repoFullName: input.repoFullName, prNumber: input.prNumber, findingId: target.id, ...common, ...data },
          update: { ...common, ...data },
        })
        .catch(async (e: unknown) => {
          if (!isUniqueConstraintError(e)) throw e;
          return db.releaseReviewRecommendation.findUniqueOrThrow({ where });
        });
      const saved = toRecommendation(row);
      if (saved) view.byFinding[target.id] = saved;
      else view.failures[target.id] = row.error ?? "AIの推奨を取得できませんでした";
    }
  }
  return view;
}
