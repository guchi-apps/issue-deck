/**
 * サンプルをプロセスの区間（`segmentKey`＝pid＋起動時刻）ごとにまとめる（#4256）。
 * デプロイ・再起動でPIDか起動時刻が変わると別区間になり、**別プロセスのピークは混ぜない**。
 */
export type SegmentSample = {
  sampledAt: Date;
  status: string;
  segmentKey: string | null;
  pid: number | null;
  startedAt: Date | null;
  rssKb: number | null;
  hwmKb: number | null;
};

export type Segment = {
  segmentKey: string;
  pid: number | null;
  startedAt: string | null;
  firstSampledAt: string;
  lastSampledAt: string;
  sampleCount: number;
  /** 区間内で観測したRSSの最大（観測できたサンプルの中での値） */
  maxObservedRssKb: number | null;
  /** その区間のプロセスが持つVmHWM（起動からのピーク）の最新値。区間をまたいで混ぜない */
  hwmKb: number | null;
};

/** 古い順のサンプルを受け取り、区間を古い順に返す。`segmentKey`の無いサンプル（取得不可）は区間に入れない */
export function summarizeSegments(samples: SegmentSample[]): Segment[] {
  const map = new Map<string, Segment>();
  for (const s of samples) {
    if (!s.segmentKey || s.status === "unavailable") continue;
    const at = s.sampledAt.toISOString();
    const cur = map.get(s.segmentKey);
    if (!cur) {
      map.set(s.segmentKey, {
        segmentKey: s.segmentKey,
        pid: s.pid,
        startedAt: s.startedAt?.toISOString() ?? null,
        firstSampledAt: at,
        lastSampledAt: at,
        sampleCount: 1,
        maxObservedRssKb: s.rssKb,
        hwmKb: s.hwmKb,
      });
      continue;
    }
    cur.sampleCount += 1;
    if (at < cur.firstSampledAt) cur.firstSampledAt = at;
    if (at >= cur.lastSampledAt) {
      cur.lastSampledAt = at;
      if (s.hwmKb !== null) cur.hwmKb = s.hwmKb;
    }
    if (s.rssKb !== null && (cur.maxObservedRssKb === null || s.rssKb > cur.maxObservedRssKb)) cur.maxObservedRssKb = s.rssKb;
  }
  return [...map.values()].sort((a, b) => (a.firstSampledAt < b.firstSampledAt ? -1 : 1));
}
