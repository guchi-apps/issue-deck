/**
 * VPSメモリ計測サンプル（#4256）の受信値の検証。サブPCの`scripts/vps-memory-probe.mjs`が送る形。
 * 取得できなかった値はnullで受け、**0や空に補わない**。不正な値は取り込まずに弾く。
 */
export const SAMPLE_STATUSES = ["ok", "partial", "unavailable"] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export type VpsMemorySampleInput = {
  sampledAt: Date;
  status: SampleStatus;
  reason: string | null;
  segmentKey: string | null;
  pid: number | null;
  startedAt: Date | null;
  rssKb: number | null;
  hwmKb: number | null;
  threads: number | null;
  uptimeSec: number | null;
  memTotalKb: bigint | null;
  memAvailableKb: bigint | null;
  swapTotalKb: bigint | null;
  swapFreeKb: bigint | null;
  nodeArgs: string | null;
  runId: string | null;
  mode: string | null;
};

export const MAX_SAMPLES_PER_REQUEST = 100;
/** 採取時刻がこれより未来のサンプルは受けない（時計のずれ・改ざん対策） */
const MAX_FUTURE_MS = 5 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function optInt(v: unknown, max = 2_147_483_647): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : "invalid";
}
function optBig(v: unknown): bigint | null | "invalid" {
  const n = optInt(v, Number.MAX_SAFE_INTEGER);
  return n === "invalid" ? n : n === null ? null : BigInt(n);
}
function optStr(v: unknown, max: number): string | null | "invalid" {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && v.length <= max ? v : "invalid";
}
function optDate(v: unknown): Date | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return "invalid";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export function parseSample(raw: unknown, now: Date): VpsMemorySampleInput | null {
  if (!isRecord(raw)) return null;
  const sampledAt = optDate(raw.sampledAt);
  if (sampledAt === null || sampledAt === "invalid" || sampledAt.getTime() > now.getTime() + MAX_FUTURE_MS) return null;
  if (typeof raw.status !== "string" || !(SAMPLE_STATUSES as readonly string[]).includes(raw.status)) return null;
  const host = isRecord(raw.host) ? raw.host : {};
  const nodeArgs = isRecord(raw.nodeArgs) ? raw.nodeArgs.value : null;
  const fields = {
    reason: optStr(raw.reason, 32),
    segmentKey: optStr(raw.segmentKey, 48),
    pid: optInt(raw.pid),
    startedAt: optDate(raw.startedAt),
    rssKb: optInt(raw.rssKb),
    hwmKb: optInt(raw.hwmKb),
    threads: optInt(raw.threads),
    uptimeSec: optInt(raw.uptimeSec),
    memTotalKb: optBig(host.memTotalKb),
    memAvailableKb: optBig(host.memAvailableKb),
    swapTotalKb: optBig(host.swapTotalKb),
    swapFreeKb: optBig(host.swapFreeKb),
    nodeArgs: optStr(nodeArgs, 255),
    runId: optStr(raw.runId, 40),
    mode: optStr(raw.mode, 16),
  };
  if (Object.values(fields).some((v) => v === "invalid")) return null;
  const f = fields as Omit<VpsMemorySampleInput, "sampledAt" | "status">;
  // 成功扱いのサンプルにRSSが無いのは不整合（取りこぼしを正常値に見せない）
  if (raw.status === "ok" && (f.rssKb === null || f.hwmKb === null || f.segmentKey === null)) return null;
  if (raw.status === "unavailable" && f.reason === null) return null;
  return { sampledAt, status: raw.status as SampleStatus, ...f };
}
