import type { ClaudeUsageWindow } from "@/lib/claude/usage";
import type { CodexUsage } from "@/lib/dispatch/codex-usage";

/**
 * iOSロック画面ウィジェット（#4890）へ返す、1サービスぶんの週間枠。
 * 経過時間の割合はウィジェット側が「いま」から計算する（次の取得までの間も目盛りを進めるため）。
 */
export type WidgetUsageWindow = {
  /** 使用率(0-100) */
  usedPercent: number;
  /** リセット時刻(epoch ms) */
  resetsAt: number;
  /** 枠の長さ(ms)。開始時刻は`resetsAt - durationMs` */
  durationMs: number;
  /** 値を観測した時刻(epoch ms) */
  fetchedAt: number;
  /** リセット時刻を過ぎている。リセット後の使用量は分からないため、ウィジェットは使用率を出さない */
  expired: boolean;
};

export type WidgetUsageResponse = {
  claude: WidgetUsageWindow | null;
  /** Claudeの5時間枠。グラフだけで描くため、週間枠と同じ形で返す */
  claudeFiveHour: WidgetUsageWindow | null;
  chatgpt: WidgetUsageWindow | null;
  generatedAt: number;
};

/**
 * Claudeの5時間枠が今まさに動いているか。動いている間は探りを送っても新しい枠を始めない
 * （「5時間枠を開けておく」#3032と同じ線）。止まっている・分からないときに送ると、
 * ウィジェットの更新だけで枠が始まってしまうため、呼び出し側は最後に見た値を返す。
 */
export function isClaudeFiveHourWindowActive(windows: readonly ClaudeUsageWindow[], nowMs: number): boolean {
  const resetsAt = windows.find((window) => window.key === "5h")?.resetsAt ?? null;
  return resetsAt !== null && resetsAt * 1000 > nowMs;
}

/** Claudeの取得結果から週間枠を取り出す。週間枠かリセット時刻が無ければnull */
export function toClaudeWidgetWindow(
  usage: { windows: readonly ClaudeUsageWindow[]; fetchedAt: number } | null,
  nowMs: number,
): WidgetUsageWindow | null {
  return pickClaudeWindow(usage, "7d", nowMs);
}

/** Claudeの取得結果から5時間枠を取り出す。5時間枠かリセット時刻が無ければnull */
export function toClaudeFiveHourWidgetWindow(
  usage: { windows: readonly ClaudeUsageWindow[]; fetchedAt: number } | null,
  nowMs: number,
): WidgetUsageWindow | null {
  return pickClaudeWindow(usage, "5h", nowMs);
}

function pickClaudeWindow(
  usage: { windows: readonly ClaudeUsageWindow[]; fetchedAt: number } | null,
  key: string,
  nowMs: number,
): WidgetUsageWindow | null {
  const weekly = usage?.windows.find((window) => window.key === key);
  if (!usage || !weekly || weekly.resetsAt === null) return null;
  const resetsAt = weekly.resetsAt * 1000;
  return {
    usedPercent: weekly.usedPercent,
    resetsAt,
    durationMs: weekly.durationMs,
    fetchedAt: usage.fetchedAt,
    expired: resetsAt <= nowMs,
  };
}

/** Codex（ChatGPTプラン）の取得結果から週間枠（`secondary`）を取り出す */
export function toCodexWidgetWindow(usage: CodexUsage | null): WidgetUsageWindow | null {
  const weekly = usage?.windows.find((window) => window.key === "secondary");
  if (!usage || !weekly) return null;
  return {
    usedPercent: weekly.usedPercent,
    resetsAt: weekly.resetsAt * 1000,
    durationMs: weekly.durationMs,
    fetchedAt: usage.fetchedAt,
    expired: weekly.expired,
  };
}
