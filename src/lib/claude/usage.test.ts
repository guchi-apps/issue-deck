import { describe, expect, it } from "vitest";
import { parseClaudeUsage, toUsedPercent } from "@/lib/claude/usage";

describe("toUsedPercent", () => {
  it("percentがあればそれをそのまま使う", () => {
    expect(toUsedPercent({ percent: 42 })).toBe(42);
  });

  it("percentを優先し、utilizationは無視する", () => {
    expect(toUsedPercent({ percent: 42, utilization: 0.9 })).toBe(42);
  });

  it("utilizationが1以下なら比率とみなして100倍する", () => {
    expect(toUsedPercent({ utilization: 0.37 })).toBeCloseTo(37);
  });

  it("utilizationが1より大きければパーセントとみなす", () => {
    expect(toUsedPercent({ utilization: 37 })).toBe(37);
  });

  it("0-100の範囲に丸める", () => {
    expect(toUsedPercent({ percent: 120 })).toBe(100);
    expect(toUsedPercent({ percent: -5 })).toBe(0);
  });

  it("数値が無ければnullを返す", () => {
    expect(toUsedPercent({})).toBeNull();
    expect(toUsedPercent({ utilization: "0.5" })).toBeNull();
    expect(toUsedPercent({ percent: Number.NaN })).toBeNull();
  });
});

describe("parseClaudeUsage", () => {
  it("5時間枠と週次枠を表示順に取り出す", () => {
    const windows = parseClaudeUsage({
      seven_day: { utilization: 0.5, resets_at: "2026-08-10T00:00:00Z" },
      five_hour: { utilization: 0.25, resets_at: "2026-08-04T18:00:00Z" },
    });

    expect(windows.map((w) => w.key)).toEqual(["five_hour", "seven_day"]);
    expect(windows[0]).toEqual({
      key: "five_hour",
      label: "5時間",
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: "2026-08-04T18:00:00Z",
    });
  });

  it("モデル別の週次枠も対象にする", () => {
    const windows = parseClaudeUsage({
      seven_day_opus: { utilization: 0.1, resets_at: "2026-08-10T00:00:00Z" },
      seven_day_sonnet: { utilization: 0.2, resets_at: "2026-08-10T00:00:00Z" },
    });

    expect(windows.map((w) => w.key)).toEqual(["seven_day_opus", "seven_day_sonnet"]);
  });

  it("is_enabledがfalseのウィンドウは除外する", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 0.25, is_enabled: false },
      seven_day: { utilization: 0.5 },
    });

    expect(windows.map((w) => w.key)).toEqual(["seven_day"]);
  });

  it("resets_atが無くても使用率だけ取り出す", () => {
    const windows = parseClaudeUsage({ five_hour: { utilization: 0.25 } });

    expect(windows).toHaveLength(1);
    expect(windows[0].resetsAt).toBeNull();
  });

  it("想定外の形でも例外を投げず空配列を返す", () => {
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage("unexpected")).toEqual([]);
    expect(parseClaudeUsage({})).toEqual([]);
    expect(parseClaudeUsage({ five_hour: "unexpected" })).toEqual([]);
    expect(parseClaudeUsage({ five_hour: {} })).toEqual([]);
  });

  it("未知のキーは無視する", () => {
    expect(parseClaudeUsage({ unknown_window: { utilization: 0.5 } })).toEqual([]);
  });
});
