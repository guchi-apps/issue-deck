import { describe, expect, it } from "vitest";

import type { ClaudeUsageWindow } from "@/lib/claude/usage";
import type { CodexUsage } from "@/lib/dispatch/codex-usage";

import { isClaudeFiveHourWindowActive, toClaudeFiveHourWidgetWindow, toClaudeWidgetWindow, toCodexWidgetWindow } from "./widget-usage";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const WEEK_MS = 7 * 24 * 60 * 60_000;

function claudeWindow(key: string, resetsAtMs: number | null, usedPercent = 40): ClaudeUsageWindow {
  return {
    key,
    label: key,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: resetsAtMs === null ? null : resetsAtMs / 1000,
    status: "allowed",
    durationMs: key === "7d" ? WEEK_MS : 5 * 60 * 60_000,
  };
}

describe("isClaudeFiveHourWindowActive", () => {
  it("5時間枠のリセットが未来なら動いている", () => {
    expect(isClaudeFiveHourWindowActive([claudeWindow("5h", NOW + 60_000)], NOW)).toBe(true);
  });

  it("リセットを過ぎた・5時間枠が無い・リセット時刻が無いときは動いていない", () => {
    expect(isClaudeFiveHourWindowActive([claudeWindow("5h", NOW)], NOW)).toBe(false);
    expect(isClaudeFiveHourWindowActive([claudeWindow("7d", NOW + 60_000)], NOW)).toBe(false);
    expect(isClaudeFiveHourWindowActive([claudeWindow("5h", null)], NOW)).toBe(false);
  });
});

describe("toClaudeWidgetWindow", () => {
  it("週間枠をepoch msへ直して返す", () => {
    const usage = { windows: [claudeWindow("5h", NOW + 1000), claudeWindow("7d", NOW + 3 * 86_400_000, 38)], fetchedAt: NOW - 5000 };
    expect(toClaudeWidgetWindow(usage, NOW)).toEqual({
      usedPercent: 38,
      resetsAt: NOW + 3 * 86_400_000,
      durationMs: WEEK_MS,
      fetchedAt: NOW - 5000,
      expired: false,
    });
  });

  it("リセットを過ぎていればexpired", () => {
    const usage = { windows: [claudeWindow("7d", NOW - 1000)], fetchedAt: NOW - WEEK_MS };
    expect(toClaudeWidgetWindow(usage, NOW)?.expired).toBe(true);
  });

  it("未取得・週間枠なし・リセット時刻なしはnull", () => {
    expect(toClaudeWidgetWindow(null, NOW)).toBeNull();
    expect(toClaudeWidgetWindow({ windows: [claudeWindow("5h", NOW + 1000)], fetchedAt: NOW }, NOW)).toBeNull();
    expect(toClaudeWidgetWindow({ windows: [claudeWindow("7d", null)], fetchedAt: NOW }, NOW)).toBeNull();
  });
});

describe("toClaudeFiveHourWidgetWindow", () => {
  it("5時間枠をepoch msへ直して返す", () => {
    const usage = { windows: [claudeWindow("5h", NOW + 3_600_000, 12), claudeWindow("7d", NOW + 86_400_000)], fetchedAt: NOW - 1000 };
    expect(toClaudeFiveHourWidgetWindow(usage, NOW)).toEqual({
      usedPercent: 12,
      resetsAt: NOW + 3_600_000,
      durationMs: 5 * 60 * 60_000,
      fetchedAt: NOW - 1000,
      expired: false,
    });
  });

  it("5時間枠なし・リセット時刻なしはnull", () => {
    expect(toClaudeFiveHourWidgetWindow(null, NOW)).toBeNull();
    expect(toClaudeFiveHourWidgetWindow({ windows: [claudeWindow("7d", NOW + 1000)], fetchedAt: NOW }, NOW)).toBeNull();
    expect(toClaudeFiveHourWidgetWindow({ windows: [claudeWindow("5h", null)], fetchedAt: NOW }, NOW)).toBeNull();
  });
});

describe("toCodexWidgetWindow", () => {
  const usage: CodexUsage = {
    host: "subpc",
    source: "ops-dashboard",
    planType: "pro",
    fetchedAt: NOW - 1000,
    stale: false,
    windows: [
      { key: "primary", label: "5時間", usedPercent: 10, remainingPercent: 90, resetsAt: (NOW + 3600_000) / 1000, durationMs: 300 * 60_000, expired: false },
      { key: "secondary", label: "週間", usedPercent: 21, remainingPercent: 79, resetsAt: (NOW + 5 * 86_400_000) / 1000, durationMs: WEEK_MS, expired: false },
    ],
  };

  it("週間枠（secondary）を返す", () => {
    expect(toCodexWidgetWindow(usage)).toEqual({
      usedPercent: 21,
      resetsAt: NOW + 5 * 86_400_000,
      durationMs: WEEK_MS,
      fetchedAt: NOW - 1000,
      expired: false,
    });
  });

  it("未報告・週間枠なしはnull", () => {
    expect(toCodexWidgetWindow(null)).toBeNull();
    expect(toCodexWidgetWindow({ ...usage, windows: usage.windows.slice(0, 1) })).toBeNull();
  });
});
