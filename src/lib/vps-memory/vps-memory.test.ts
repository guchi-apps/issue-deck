import { describe, expect, it } from "vitest";

import { parseSample } from "./sample";
import { summarizeSegments } from "./segments";

const now = new Date("2026-10-10T08:00:00Z");
const ok = {
  sampledAt: "2026-10-10T07:59:00Z", status: "ok", segmentKey: "1-10", pid: 1, startedAt: "2026-10-10T05:00:00Z",
  rssKb: 600000, hwmKb: 700000, host: { memAvailableKb: 900000 }, nodeArgs: { value: "--x", source: "repo-config" },
};

describe("parseSample", () => {
  it("正常なサンプルを取り込む", () => {
    expect(parseSample(ok, now)).toMatchObject({ status: "ok", pid: 1, rssKb: 600000, memAvailableKb: BigInt(900000), nodeArgs: "--x" });
  });
  it("okなのにRSSが無い・負数・未来の時刻・不明なstatusは弾く", () => {
    expect(parseSample({ ...ok, rssKb: null }, now)).toBeNull();
    expect(parseSample({ ...ok, rssKb: -1 }, now)).toBeNull();
    expect(parseSample({ ...ok, sampledAt: "2026-10-11T00:00:00Z" }, now)).toBeNull();
    expect(parseSample({ ...ok, status: "fine" }, now)).toBeNull();
  });
  it("取得不可は理由が必須で、値はnullのまま保存する", () => {
    expect(parseSample({ sampledAt: ok.sampledAt, status: "unavailable" }, now)).toBeNull();
    expect(parseSample({ sampledAt: ok.sampledAt, status: "unavailable", reason: "timeout" }, now)).toMatchObject({ rssKb: null, pid: null });
  });
});

describe("summarizeSegments", () => {
  const s = (key: string | null, at: string, rss: number | null, hwm: number | null, status = "ok") => ({
    sampledAt: new Date(at), status, segmentKey: key, pid: key ? Number(key.split("-")[0]) : null, startedAt: null, rssKb: rss, hwmKb: hwm,
  });
  it("PIDが変わったら別区間にし、ピークを混ぜない。取得不可は区間に入れない", () => {
    const segs = summarizeSegments([
      s("1-10", "2026-10-10T01:00:00Z", 500, 700),
      s(null, "2026-10-10T01:01:00Z", null, null, "unavailable"),
      s("1-10", "2026-10-10T01:02:00Z", 650, 750),
      s("2-20", "2026-10-10T01:05:00Z", 300, 310),
    ]);
    expect(segs.map((x) => [x.segmentKey, x.sampleCount, x.maxObservedRssKb, x.hwmKb])).toEqual([["1-10", 2, 650, 750], ["2-20", 1, 300, 310]]);
  });
});
