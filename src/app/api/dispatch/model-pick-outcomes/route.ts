import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { buildModelPickOutcomes } from "@/lib/model-pick-outcomes";

/** 既定の集計期間（日）と上限。上限は`SessionUsage`の保持期間（180日）に揃える */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 180;

function parseDays(value: string | null): number {
  if (value === null) return DEFAULT_DAYS;
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? Math.min(days, MAX_DAYS) : DEFAULT_DAYS;
}

function parseModels(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((model): model is string => typeof model === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 「おまかせ」のモデル判定の当たり外れの集計（#4852）。端末からは`scripts/model-pick-outcomes.sh`で叩く。
 *
 * 期間内に積まれたClaudeの起動ジョブと、同じ期間の使用量（`SessionUsage`）を読み、
 * `buildModelPickOutcomes`へ渡すだけ。読み取りのみで、何も書き換えない。
 *
 * 認証は`/claim`・`/session-usage`と同じ共有シークレット（`DISPATCH_SECRET`）。費用は既存の
 * 使用量の受け口でも同じ鍵で扱っており、新しい権限は足さない。
 */
export async function GET(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [launches, usages] = await Promise.all([
    db.dispatchJob.findMany({
      // 取り消し・見送りは起動していないので、再起動として数えない
      where: { kind: "LAUNCH", agent: "claude", createdAt: { gte: since }, status: { notIn: ["CANCELED", "SKIPPED"] } },
      select: {
        repositoryFullName: true,
        issueNumber: true,
        createdAt: true,
        claudeModel: true,
        modelPickSource: true,
        modelPickModel: true,
        modelPickProbabilities: true,
      },
    }),
    db.sessionUsage.findMany({
      where: { endedAt: { gte: since } },
      select: {
        source: true,
        kind: true,
        repository: true,
        issueNumber: true,
        prNumber: true,
        workflowName: true,
        costUsd: true,
        models: true,
      },
    }),
  ]);

  const summary = buildModelPickOutcomes(
    launches,
    usages.map((usage) => ({ ...usage, models: parseModels(usage.models) })),
  );

  return NextResponse.json({ days, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
