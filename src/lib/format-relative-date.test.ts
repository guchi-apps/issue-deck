import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRelativeDate } from "@/lib/format-relative-date";

const NOW = new Date(2026, 7, 18, 12, 0, 0);

/** NOWから`ms`ミリ秒だけ過去の時刻 */
function ago(ms: number) {
  return new Date(NOW.getTime() - ms).toISOString();
}

const MINUTE = 1000 * 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeDate", () => {
  it("1分未満は「たった今」", () => {
    expect(formatRelativeDate(ago(0))).toBe("たった今");
    expect(formatRelativeDate(ago(59 * 1000))).toBe("たった今");
  });

  // 報告のタイムスタンプがこちらの時計より少し先を行くことがある
  it("未来の時刻も「たった今」に丸める", () => {
    expect(formatRelativeDate(new Date(NOW.getTime() + HOUR).toISOString())).toBe("たった今");
  });

  // #1891。1時間未満を「1時間以内」などに丸めず、分まで刻む
  it("1時間未満は分で刻む", () => {
    expect(formatRelativeDate(ago(MINUTE))).toBe("1分前");
    expect(formatRelativeDate(ago(59 * MINUTE))).toBe("59分前");
  });

  // #1891。当日ぶんを「今日」に丸めず、時間まで刻む
  it("1日未満は時間で刻む", () => {
    expect(formatRelativeDate(ago(HOUR))).toBe("1時間前");
    expect(formatRelativeDate(ago(DAY - MINUTE))).toBe("23時間前");
  });

  it("1日以上は日で刻む", () => {
    expect(formatRelativeDate(ago(DAY))).toBe("1日前");
    expect(formatRelativeDate(ago(3 * DAY + 5 * HOUR))).toBe("3日前");
  });
});
