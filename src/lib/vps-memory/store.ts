import { db } from "@/lib/db";
import { summarizeSegments, type Segment } from "./segments";
import type { VpsMemorySampleInput } from "./sample";

/** 保存期間と件数の上限（収集による保存量の制限。#4256） */
export const RETENTION_DAYS = 7;
export const MAX_STORED_SAMPLES = 20_000;
export const MAX_HISTORY_SAMPLES = 1000;

export async function saveSamples(samples: VpsMemorySampleInput[], now = new Date()): Promise<void> {
  await db.vpsMemorySample.createMany({ data: samples });
  await db.vpsMemorySample.deleteMany({ where: { sampledAt: { lt: new Date(now.getTime() - RETENTION_DAYS * 86_400_000) } } });
  const overflow = await db.vpsMemorySample.count();
  if (overflow > MAX_STORED_SAMPLES) {
    const cutoff = await db.vpsMemorySample.findFirst({
      orderBy: { sampledAt: "desc" },
      skip: MAX_STORED_SAMPLES,
      select: { sampledAt: true },
    });
    if (cutoff) await db.vpsMemorySample.deleteMany({ where: { sampledAt: { lte: cutoff.sampledAt } } });
  }
}

type Row = Awaited<ReturnType<typeof db.vpsMemorySample.findMany>>[number];

const kb = (v: bigint | null) => (v === null ? null : Number(v));

export function toSampleJson(r: Row) {
  return {
    sampledAt: r.sampledAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    status: r.status,
    reason: r.reason,
    segmentKey: r.segmentKey,
    pid: r.pid,
    startedAt: r.startedAt?.toISOString() ?? null,
    rssKb: r.rssKb,
    hwmKb: r.hwmKb,
    threads: r.threads,
    uptimeSec: r.uptimeSec,
    host: {
      memTotalKb: kb(r.memTotalKb),
      memAvailableKb: kb(r.memAvailableKb),
      swapTotalKb: kb(r.swapTotalKb),
      swapFreeKb: kb(r.swapFreeKb),
    },
    nodeArgs: r.nodeArgs,
    runId: r.runId,
    mode: r.mode,
  };
}

export type VpsMemoryReport = {
  schemaVersion: 1;
  generatedAt: string;
  /** 最新サンプル。取得不可でもそのまま返す（reasonつき）。1件も無ければnull */
  latest: ReturnType<typeof toSampleJson> | null;
  /** 最後に取得できた（ok/partial）サンプルの採取時刻。取得不可が続いても分かるようにする */
  lastSuccessAt: string | null;
  /** 最新サンプルを受け取ってからの経過秒。大きければサブPC停止・計測未実行を疑う（正常値とは読まない） */
  latestAgeSeconds: number | null;
  segments: Segment[];
  samples?: ReturnType<typeof toSampleJson>[];
  note: string;
};

export async function loadReport(opts: { hours: number; includeSamples: boolean; now?: Date }): Promise<VpsMemoryReport> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.hours * 3_600_000);
  const [latest, lastSuccess, recentDesc] = await Promise.all([
    db.vpsMemorySample.findFirst({ orderBy: { sampledAt: "desc" } }),
    db.vpsMemorySample.findFirst({ where: { status: { in: ["ok", "partial"] } }, orderBy: { sampledAt: "desc" }, select: { sampledAt: true } }),
    db.vpsMemorySample.findMany({ where: { sampledAt: { gte: since } }, orderBy: { sampledAt: "desc" }, take: MAX_HISTORY_SAMPLES }),
  ]);
  const recent = recentDesc.reverse();
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    latest: latest ? toSampleJson(latest) : null,
    lastSuccessAt: lastSuccess?.sampledAt.toISOString() ?? null,
    latestAgeSeconds: latest ? Math.max(0, Math.round((now.getTime() - latest.sampledAt.getTime()) / 1000)) : null,
    segments: summarizeSegments(recent),
    ...(opts.includeSamples ? { samples: recent.map(toSampleJson) } : {}),
    note: "計測は手動起動（常時実行なし）。heap・PM2再起動数・smapsは権限が無く取得していない。segmentsはPID・起動時刻ごとの別プロセス。",
  };
}
