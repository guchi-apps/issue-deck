import {
  NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
  NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
  parseNextWindowRunIntervalMinutes,
  parseNextWindowRunLeadMinutes,
} from "@/lib/app-settings";
import { fetchClaudeUsage } from "@/lib/claude/usage";
import { db } from "@/lib/db";
import type { ClaudeWindowSnapshot, NextWindowRunSettings } from "@/lib/next-window-run";

/**
 * 次枠実行（#2995）のうち、DBと使用量APIを読む部分。
 *
 * **`nightly-run-db.ts`とは分けてある。** あちらは確認待ちPushの巡回（Webhookの受け口からも
 * 呼ばれる）が読む軽い層で、ここは`claude/usage.ts`＝Anthropic APIへの送信を引きずる。
 */

export async function readNextWindowRunSettings(): Promise<NextWindowRunSettings> {
  const row = await db.appSetting.findUnique({
    where: { id: 1 },
    select: {
      nextWindowRunEnabled: true,
      nextWindowRunLeadMinutes: true,
      nextWindowRunIntervalMinutes: true,
    },
  });
  return {
    enabled: row?.nextWindowRunEnabled ?? false,
    leadMinutes:
      parseNextWindowRunLeadMinutes(row?.nextWindowRunLeadMinutes) ??
      NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
    intervalMinutes:
      parseNextWindowRunIntervalMinutes(row?.nextWindowRunIntervalMinutes) ??
      NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
  };
}

/**
 * いまのClaude 5時間枠を読む。取得できなければ`null`（呼び出し側は起動しない）。
 *
 * **この取得は最小の推論リクエスト1本で、送信そのものが枠を開始する**（`claude/usage.ts`）。
 * 予約が1件も無いとき・次枠実行がOFFのときは呼ばないこと。`fetchClaudeUsage`側に5分の
 * キャッシュがあるので、pollerが30秒ごとに呼んでも実際の送信は5分に1回に収まる。
 */
export async function readClaudeWindowSnapshot(): Promise<ClaudeWindowSnapshot | null> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;
  try {
    const usage = await fetchClaudeUsage(token);
    const window = usage.windows.find((entry) => entry.key === "5h");
    if (!window) return null;
    return {
      resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      usedPercent: window.usedPercent,
    };
  } catch {
    // 非公開ヘッダに頼っているので、取れない日があっても画面と起動処理は止めない
    return null;
  }
}

/** 次の5時間枠に積まれている予定の件数（0なら枠を取りに行かない） */
export async function countQueuedNextWindowEntries(targetHost?: string): Promise<number> {
  return db.nightlyRunEntry.count({
    where: { status: "QUEUED", kind: "NEXT_WINDOW", ...(targetHost ? { targetHost } : {}) },
  });
}

/** 同じホストで直前に起動した次枠実行の時刻。まだ無ければ`null`（起動の間隔を測るのに使う） */
export async function readLastNextWindowLaunchedAt(targetHost: string): Promise<Date | null> {
  const row = await db.nightlyRunEntry.findFirst({
    where: { kind: "NEXT_WINDOW", status: "LAUNCHED", targetHost, resolvedAt: { not: null } },
    orderBy: { resolvedAt: "desc" },
    select: { resolvedAt: true },
  });
  return row?.resolvedAt ?? null;
}
