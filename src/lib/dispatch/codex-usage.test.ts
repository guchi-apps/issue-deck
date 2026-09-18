import { describe, expect, it } from "vitest";

import { parseCodexUsageReport, toCodexUsage } from "@/lib/dispatch/codex-usage";

const valid = {
  observedAt: "2026-08-30T06:18:08.986Z",
  planType: "plus",
  primary: { usedPercent: 45, windowMinutes: 300, resetsAt: "2026-08-30T08:00:00Z" },
  secondary: { usedPercent: 7, windowMinutes: 10_080, resetsAt: "2026-09-06T03:00:00Z" },
};

describe("parseCodexUsageReport", () => {
  it("2つの枠とプラン種別を検証する", () => {
    expect(parseCodexUsageReport(valid)).toEqual({
      observedAt: new Date(valid.observedAt),
      planType: "plus",
      primary: { ...valid.primary, resetsAt: new Date(valid.primary.resetsAt) },
      secondary: { ...valid.secondary, resetsAt: new Date(valid.secondary.resetsAt) },
    });
  });

  it.each([
    { ...valid, primary: { ...valid.primary, usedPercent: 101 } },
    { ...valid, secondary: null },
    { ...valid, observedAt: "broken" },
    { ...valid, planType: "x".repeat(65) },
  ])("壊れた報告を拒否する", (value) => {
    expect(parseCodexUsageReport(value)).toBeNull();
  });
});

describe("toCodexUsage", () => {
  it("5時間・週間の残量と古さを画面用へ変換する", () => {
    const observedAt = new Date("2026-08-30T06:00:00Z");
    const usage = toCodexUsage(
      {
        host: "subpc",
        planType: "plus",
        observedAt,
        primaryUsedPercent: 45,
        primaryWindowMinutes: 300,
        primaryResetsAt: new Date("2026-08-30T08:00:00Z"),
        secondaryUsedPercent: 7,
        secondaryWindowMinutes: 10_080,
        secondaryResetsAt: new Date("2026-09-06T03:00:00Z"),
      },
      observedAt.getTime() + 16 * 60_000,
    );
    expect(usage.stale).toBe(true);
    expect(usage.windows.map(({ label, usedPercent, remainingPercent }) => ({ label, usedPercent, remainingPercent }))).toEqual([
      { label: "5時間", usedPercent: 45, remainingPercent: 55 },
      { label: "週間", usedPercent: 7, remainingPercent: 93 },
    ]);
  });

  it("リセット時刻を過ぎた枠は0%とし、次のリセット時刻を枠の長さずつ進める（#3037）", () => {
    const usage = toCodexUsage(
      {
        host: "subpc",
        planType: "plus",
        observedAt: new Date("2026-08-30T06:00:00Z"),
        primaryUsedPercent: 45,
        primaryWindowMinutes: 300,
        primaryResetsAt: new Date("2026-08-30T08:00:00Z"),
        secondaryUsedPercent: 70,
        secondaryWindowMinutes: 10_080,
        secondaryResetsAt: new Date("2026-09-06T03:00:00Z"),
      },
      new Date("2026-09-14T00:00:00Z").getTime(),
    );
    const weekly = usage.windows[1];
    expect(weekly).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
    expect(new Date(weekly.resetsAt * 1000).toISOString()).toBe("2026-09-20T03:00:00.000Z");
  });
});
