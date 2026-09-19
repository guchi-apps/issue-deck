import { db } from "@/lib/db";
import { fetchOpsDashboardCodexUsage } from "@/lib/dispatch/ops-dashboard-codex-usage";

export type CodexUsageWindow = {
  key: "primary" | "secondary";
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number;
  durationMs: number;
  /**
   * 転記のスナップショットで、リセット時刻を過ぎた枠（#3052）。リセット後の使用量は分からない
   * （転記はサブPCでCodexを動かしたときしか更新されず、他端末での使用も知らない）ため、
   * 使用率・リセット時刻は最後に観測した値のままにし、画面は「取得できていない」と出す。
   */
  expired: boolean;
};

export type CodexUsage = {
  windows: CodexUsageWindow[];
  planType: string | null;
  host: string;
  /** ops-dashboardから読んだ値か、サブPCの転記のスナップショットへ戻った値か（#3052） */
  source: "ops-dashboard" | "transcript";
  fetchedAt: number;
  stale: boolean;
};

export type CodexUsageReport = {
  observedAt: Date;
  planType: string | null;
  primary: { usedPercent: number; windowMinutes: number; resetsAt: Date };
  secondary: { usedPercent: number; windowMinutes: number; resetsAt: Date };
};

const STALE_AFTER_MS = 15 * 60_000;

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseWindow(value: unknown): CodexUsageReport["primary"] | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const usedPercent = input.usedPercent;
  const windowMinutes = input.windowMinutes;
  const resetsAt = parseTimestamp(input.resetsAt);
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof windowMinutes !== "number" ||
    !Number.isSafeInteger(windowMinutes) ||
    windowMinutes <= 0 ||
    !resetsAt
  ) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAt };
}

export function parseCodexUsageReport(value: unknown): CodexUsageReport | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const observedAt = parseTimestamp(input.observedAt);
  const primary = parseWindow(input.primary);
  const secondary = parseWindow(input.secondary);
  const planType = input.planType;
  if (!observedAt || !primary || !secondary) return null;
  if (planType !== null && planType !== undefined && (typeof planType !== "string" || planType.length > 64)) {
    return null;
  }
  return { observedAt, primary, secondary, planType: typeof planType === "string" ? planType : null };
}

export async function storeCodexUsage(host: string, report: CodexUsageReport, reportedAt = new Date()) {
  const data = {
    primaryUsedPercent: report.primary.usedPercent,
    primaryWindowMinutes: report.primary.windowMinutes,
    primaryResetsAt: report.primary.resetsAt,
    secondaryUsedPercent: report.secondary.usedPercent,
    secondaryWindowMinutes: report.secondary.windowMinutes,
    secondaryResetsAt: report.secondary.resetsAt,
    planType: report.planType,
    observedAt: report.observedAt,
    reportedAt,
  };
  return db.codexUsageSnapshot.upsert({ where: { host }, create: { host, ...data }, update: data });
}

function windowLabel(minutes: number): string {
  if (minutes === 300) return "5時間";
  if (minutes === 10_080) return "週間";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}日`;
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}

export function toCodexUsage(row: {
  host: string;
  primaryUsedPercent: number;
  primaryWindowMinutes: number;
  primaryResetsAt: Date;
  secondaryUsedPercent: number;
  secondaryWindowMinutes: number;
  secondaryResetsAt: Date;
  planType: string | null;
  observedAt: Date;
}, now = Date.now()): CodexUsage {
  const makeWindow = (
    key: CodexUsageWindow["key"], usedPercent: number, minutes: number, resetsAt: Date,
  ): CodexUsageWindow => {
    const durationMs = minutes * 60_000;
    // 以前（#3037）はリセット済みの枠を0%とし、リセット時刻を枠の長さずつ進めて推定していた。
    // Codexの週間枠は時計の境界で始まらず、他端末での使用も転記には載らないため、推定は
    // 実際（使用51%・あと14時間）と食い違った（#3052）。分からないものは分からないと返す。
    return {
      key,
      label: windowLabel(minutes),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: Math.floor(resetsAt.getTime() / 1000),
      durationMs,
      expired: resetsAt.getTime() <= now,
    };
  };
  return {
    host: row.host,
    source: "transcript",
    planType: row.planType,
    fetchedAt: row.observedAt.getTime(),
    stale: now - row.observedAt.getTime() > STALE_AFTER_MS,
    windows: [
      makeWindow("primary", row.primaryUsedPercent, row.primaryWindowMinutes, row.primaryResetsAt),
      makeWindow("secondary", row.secondaryUsedPercent, row.secondaryWindowMinutes, row.secondaryResetsAt),
    ],
  };
}

export async function getLatestCodexUsage(): Promise<CodexUsage | null> {
  const row = await db.codexUsageSnapshot.findFirst({ orderBy: { observedAt: "desc" } });
  return row ? toCodexUsage(row) : null;
}

/**
 * 画面に出すCodex枠。ops-dashboardから読めればそれを使い、読めなければ転記のスナップショットへ戻る
 * （#3037。転記はCodexを動かした日にしか更新されないため、ops-dashboardの値を正とする）。
 */
export async function getCodexUsage(): Promise<CodexUsage | null> {
  return (await fetchOpsDashboardCodexUsage()) ?? (await getLatestCodexUsage());
}
