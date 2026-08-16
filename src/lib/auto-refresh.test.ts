import { describe, expect, it } from "vitest";

import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  autoRefreshIntervalLabel,
  normalizeAutoRefreshInterval,
  shorterAutoRefreshInterval,
} from "@/lib/auto-refresh";

describe("autoRefreshIntervalLabel", () => {
  it("分で割り切れる間隔は分で出す", () => {
    expect(autoRefreshIntervalLabel(60_000)).toBe("1分間隔");
    expect(autoRefreshIntervalLabel(600_000)).toBe("10分間隔");
  });

  it("分に満たない間隔は秒で出す（「完了したPR」ビューの10秒。#1531）", () => {
    expect(autoRefreshIntervalLabel(10_000)).toBe("10秒間隔");
  });
});

describe("normalizeAutoRefreshInterval", () => {
  it("選択肢にある値はそのまま通す", () => {
    for (const option of AUTO_REFRESH_INTERVAL_OPTIONS) {
      expect(normalizeAutoRefreshInterval(option.value)).toBe(option.value);
    }
  });

  it("選択肢に無い値・壊れた値は「自動更新しない」へ倒す", () => {
    // localStorageは手で書き換えられる。1秒間隔のような値を受け入れるとGitHub APIを
    // 叩き続けることになる
    expect(normalizeAutoRefreshInterval(1_000)).toBeNull();
    expect(normalizeAutoRefreshInterval("60000")).toBeNull();
    expect(normalizeAutoRefreshInterval(true)).toBeNull();
    expect(normalizeAutoRefreshInterval(undefined)).toBeNull();
  });
});

describe("shorterAutoRefreshInterval", () => {
  it("両方に要求があれば短い方を採る", () => {
    expect(shorterAutoRefreshInterval(10_000, 60_000)).toBe(10_000);
    expect(shorterAutoRefreshInterval(600_000, 60_000)).toBe(60_000);
  });

  it("片方だけの要求はその値になる", () => {
    expect(shorterAutoRefreshInterval(null, 60_000)).toBe(60_000);
    expect(shorterAutoRefreshInterval(60_000, null)).toBe(60_000);
  });

  it("どちらも要求が無ければ自動更新しない", () => {
    expect(shorterAutoRefreshInterval(null, null)).toBeNull();
  });
});
