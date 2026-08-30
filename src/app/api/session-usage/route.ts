import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchClaudeUsage } from "@/lib/claude/usage";
import { db } from "@/lib/db";
import { getLatestCodexUsage } from "@/lib/dispatch/codex-usage";
import {
  buildQuotaScale,
  buildSessionUsageSummary,
  sessionUsagePeriodStartMs,
  type SessionUsageEntry,
} from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）が読む集計。
 *
 * **materialはサブPCのpollerが押し込んだ`SessionUsage`の行だけ**で、ここから転記を読みには
 * 行かない（本番のissue-deckは転記を持たない）。
 *
 * **プラン枠への換算のために、枠のメーターも一緒に返す。** 画面が`/api/claude/usage`を別に
 * 叩くと取得が2本走るうえ、換算の物差し（`buildQuotaScale`）はセッションの行と枠の両方を
 * 見ないと作れない。取得は`lib/claude/usage.ts`が5分キャッシュしているので、設定画面と
 * 同時に開いてもプラン枠を余分に消費しない。
 */

/** 画面に出す期間の選択肢（日）。今日を含む */
const ALLOWED_DAYS = [1, 7, 30] as const;
const DEFAULT_DAYS = 7;

/**
 * 枠の換算に使う窓は最長7日なので、期間より手前も少しだけ読む。
 * **期間の切り出しは`buildSessionUsageSummary`が行う**ので、ここで多めに取っても数字はずれない。
 */
const QUOTA_LOOKBACK_DAYS = 8;

function parseDays(value: string | null): number {
  const parsed = Number(value);
  return (ALLOWED_DAYS as readonly number[]).includes(parsed) ? parsed : DEFAULT_DAYS;
}

/** DBの行（BigInt）を、そのままJSONにできる形へ落とす */
function toEntry(row: {
  agent: string;
  sessionId: string;
  host: string;
  kind: string;
  repository: string | null;
  issueNumber: number | null;
  responses: number;
  inputTokens: bigint;
  cacheCreate5mTokens: bigint;
  cacheCreate1hTokens: bigint;
  cacheReadTokens: bigint;
  outputTokens: bigint;
  costUsd: number;
  models: string;
  startedAt: Date;
  endedAt: Date;
}): SessionUsageEntry {
  const inputTokens = Number(row.inputTokens);
  const cacheCreateTokens = Number(row.cacheCreate5mTokens) + Number(row.cacheCreate1hTokens);
  const cacheReadTokens = Number(row.cacheReadTokens);

  // モデルの配列は報告時にJSONで入れている。壊れていても行ごと落とさず空扱いにする。
  let models: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.models);
    if (Array.isArray(parsed)) models = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    models = [];
  }

  return {
    agent: row.agent === "codex" ? "codex" : "claude",
    sessionId: row.sessionId,
    host: row.host,
    kind: row.kind,
    repository: row.repository,
    issueNumber: row.issueNumber,
    responses: row.responses,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens: Number(row.outputTokens),
    contextTokens: inputTokens + cacheCreateTokens + cacheReadTokens,
    costUsd: row.costUsd,
    models,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));
  const nowMs = Date.now();
  const periodStartMs = sessionUsagePeriodStartMs(nowMs, days);
  const quotaStartMs = nowMs - QUOTA_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const sinceMs = Math.min(periodStartMs, quotaStartMs);

  const rows = await db.sessionUsage.findMany({
    where: { endedAt: { gte: new Date(sinceMs) } },
    orderBy: { endedAt: "desc" },
    select: {
      sessionId: true,
      agent: true,
      host: true,
      kind: true,
      repository: true,
      issueNumber: true,
      responses: true,
      inputTokens: true,
      cacheCreate5mTokens: true,
      cacheCreate1hTokens: true,
      cacheReadTokens: true,
      outputTokens: true,
      costUsd: true,
      models: true,
      startedAt: true,
      endedAt: true,
      reportedAt: true,
    },
  });

  const entries = rows.map(toEntry);
  const reportedAt = rows.reduce<Date | null>((latest, row) => {
    return latest === null || row.reportedAt > latest ? row.reportedAt : latest;
  }, null);

  // **プラン枠の取得に失敗しても画面は出す。** 非公開のヘッダに依存しているので、
  // 取れない日があっても「枠換算が出ないだけ」で済ませる（設定画面と同じ扱い）。
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const [claudePlanUsage, codexPlanUsage] = await Promise.all([
    token ? fetchClaudeUsage(token).catch(() => null) : Promise.resolve(null),
    getLatestCodexUsage().catch(() => null),
  ]);
  const entriesByAgent = {
    claude: entries.filter((entry) => entry.agent === "claude"),
    codex: entries.filter((entry) => entry.agent === "codex"),
  };
  const quotaByAgent = {
    claude: claudePlanUsage
      ? buildQuotaScale({ windows: claudePlanUsage.windows, entries: entriesByAgent.claude, nowMs })
      : null,
    codex: codexPlanUsage
      ? buildQuotaScale({ windows: codexPlanUsage.windows, entries: entriesByAgent.codex, nowMs })
      : null,
  };

  const summary = buildSessionUsageSummary({
    entries,
    nowMs,
    days,
    reportedAt: reportedAt?.toISOString() ?? null,
    quotaByAgent,
  });

  return NextResponse.json(
    {
      ...summary,
      planUsage: { claude: claudePlanUsage, codex: codexPlanUsage },
      planNotConfigured: { claude: !token, codex: !codexPlanUsage },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
