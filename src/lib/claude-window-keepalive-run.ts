import {
  CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT,
  CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT,
  parseClaudeWindowKeepAliveHour,
} from "@/lib/app-settings";
import {
  decideClaudeWindowKeepAlive,
  type ClaudeWindowKeepAliveDecision,
  type ClaudeWindowKeepAliveSettings,
} from "@/lib/claude-window-keepalive";
import { peekClaudeFiveHourWindow } from "@/lib/claude/usage";
import { db } from "@/lib/db";
import { readClaudeWindowSnapshot } from "@/lib/next-window-run-db";

/**
 * 5時間枠を開けておく（#3032）のうち、DBと使用量APIを読む部分。判定は
 * `claude-window-keepalive.ts`の純関数が持つ。
 *
 * 契機は`POST /api/dispatch/claim`（非fast）への相乗り（次枠実行と同じ）。探りの送信は
 * `readClaudeWindowSnapshot`（`claude/usage.ts`の`fetchClaudeUsage`）をそのまま使い、
 * タイムアウト（10秒）・消費量への計上（「プラン枠の取得」）も同じ経路に乗る。
 */

export async function readClaudeWindowKeepAliveSettings(): Promise<
  ClaudeWindowKeepAliveSettings & { probedAt: Date | null }
> {
  const row = await db.appSetting.findUnique({
    where: { id: 1 },
    select: {
      claudeWindowKeepAliveEnabled: true,
      claudeWindowKeepAliveStartHour: true,
      claudeWindowKeepAliveEndHour: true,
      claudeWindowKeepAliveProbedAt: true,
    },
  });
  return {
    enabled: row?.claudeWindowKeepAliveEnabled ?? false,
    startHour:
      parseClaudeWindowKeepAliveHour(row?.claudeWindowKeepAliveStartHour) ??
      CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT,
    endHour:
      parseClaudeWindowKeepAliveHour(row?.claudeWindowKeepAliveEndHour) ??
      CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT,
    probedAt: row?.claudeWindowKeepAliveProbedAt ?? null,
  };
}

export type ClaudeWindowKeepAliveResult = {
  decision: ClaudeWindowKeepAliveDecision;
  /** 探りを送った結果のリセット時刻(epoch ms)。送っていない・取れなかったときはnull */
  resetsAt: number | null;
};

/** 枠が止まっていれば探りを1本送って開ける。送らないときはAPIもDBの書き込みも行わない */
export async function keepClaudeWindowOpen(params: { now?: Date } = {}): Promise<ClaudeWindowKeepAliveResult> {
  const now = params.now ?? new Date();
  const settings = await readClaudeWindowKeepAliveSettings();
  const decision = decideClaudeWindowKeepAlive({
    settings,
    now,
    knownResetsAt: peekClaudeFiveHourWindow()?.resetsAt ?? null,
    lastProbedAt: settings.probedAt,
  });
  if (decision.action !== "probe") return { decision, resetsAt: null };

  // 送る前に時刻を残す。探りが詰まって10秒のタイムアウトまで待った場合でも、
  // 次の巡回で重ねて送らないようにするため（`CLAUDE_WINDOW_KEEPALIVE_RETRY_MS`）
  await db.appSetting.updateMany({
    where: { id: 1 },
    data: { claudeWindowKeepAliveProbedAt: now },
  });
  const snapshot = await readClaudeWindowSnapshot();
  return { decision, resetsAt: snapshot?.resetsAt ?? null };
}
