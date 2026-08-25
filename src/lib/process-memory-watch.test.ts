import { describe, expect, it } from "vitest";

import {
  formatProcessMemoryLine,
  MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS,
  MEMORY_WATCH_DEFAULT_STEP_MB,
  memoryWatchIntervalSeconds,
  memoryWatchStepMb,
  shouldLogProcessMemory,
  startProcessMemoryWatch,
  type ProcessMemorySample,
} from "@/lib/process-memory-watch";

const MB = 1024 * 1024;

function sample(rssMb: number): ProcessMemorySample {
  return {
    rss: rssMb * MB,
    heapTotal: 217 * MB,
    heapUsed: 128 * MB,
    external: 41 * MB,
  };
}

describe("memoryWatchIntervalSeconds", () => {
  it("環境変数が無ければ既定値", () => {
    expect(memoryWatchIntervalSeconds(undefined)).toBe(MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS);
    expect(memoryWatchIntervalSeconds("  ")).toBe(MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS);
  });

  it("数値でなければ既定値へ倒す", () => {
    expect(memoryWatchIntervalSeconds("abc")).toBe(MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS);
    expect(memoryWatchIntervalSeconds("-1")).toBe(MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS);
  });

  it("0は「見張らない」として尊重する", () => {
    expect(memoryWatchIntervalSeconds("0")).toBe(0);
  });
});

describe("memoryWatchStepMb", () => {
  it("読めない値は既定値へ倒す", () => {
    expect(memoryWatchStepMb(undefined)).toBe(MEMORY_WATCH_DEFAULT_STEP_MB);
    expect(memoryWatchStepMb("0")).toBe(MEMORY_WATCH_DEFAULT_STEP_MB);
    expect(memoryWatchStepMb("abc")).toBe(MEMORY_WATCH_DEFAULT_STEP_MB);
  });

  it("正の数はそのまま使う", () => {
    expect(memoryWatchStepMb("32")).toBe(32);
  });
});

describe("shouldLogProcessMemory", () => {
  it("最初の1回は必ず出す", () => {
    expect(
      shouldLogProcessMemory({ rssBytes: 150 * MB, lastLoggedRssBytes: null, stepMb: 16 }),
    ).toBe(true);
  });

  it("最大値を更新幅ぶん超えたときだけ出す", () => {
    expect(
      shouldLogProcessMemory({ rssBytes: 165 * MB, lastLoggedRssBytes: 150 * MB, stepMb: 16 }),
    ).toBe(false);
    expect(
      shouldLogProcessMemory({ rssBytes: 166 * MB, lastLoggedRssBytes: 150 * MB, stepMb: 16 }),
    ).toBe(true);
  });

  it("下がったときは出さない（GCの揺れでログを埋めない）", () => {
    expect(
      shouldLogProcessMemory({ rssBytes: 100 * MB, lastLoggedRssBytes: 480 * MB, stepMb: 16 }),
    ).toBe(false);
  });
});

describe("formatProcessMemoryLine", () => {
  it("pm2 logsでそのまま読める1行にする", () => {
    expect(formatProcessMemoryLine(sample(482), 312.4)).toBe(
      "[memory] rss=482MB heapTotal=217MB heapUsed=128MB external=41MB uptime=312s",
    );
  });
});

describe("startProcessMemoryWatch", () => {
  it("起動直後の基準値を1行だけ出す", () => {
    const lines: string[] = [];
    const stop = startProcessMemoryWatch({
      intervalSeconds: 60,
      stepMb: 16,
      sample: () => sample(150),
      uptimeSeconds: () => 1,
      log: (line) => lines.push(line),
    });
    stop();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("rss=150MB");
  });

  it("間隔が0なら何も出さず、タイマーも張らない", () => {
    const lines: string[] = [];
    const stop = startProcessMemoryWatch({
      intervalSeconds: 0,
      sample: () => sample(150),
      log: (line) => lines.push(line),
    });
    stop();

    expect(lines).toEqual([]);
  });
});
