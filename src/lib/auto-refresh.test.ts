import { describe, expect, it } from "vitest";

import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  autoRefreshIntervalLabel,
  describeAutoRefreshState,
  describeRefreshButtonHint,
  ISSUE_POLL_INTERVAL_MS,
  PULL_REQUEST_POLL_INTERVAL_MS,
  normalizeAutoRefreshInterval,
  shorterAutoRefreshInterval,
} from "@/lib/auto-refresh";

describe("autoRefreshIntervalLabel", () => {
  it("分で割り切れる間隔は分で出す", () => {
    expect(autoRefreshIntervalLabel(60_000)).toBe("1分間隔");
    expect(autoRefreshIntervalLabel(600_000)).toBe("10分間隔");
  });

  it("分に満たない間隔は秒で出す（一覧の10秒。#1531・#1947）", () => {
    expect(autoRefreshIntervalLabel(PULL_REQUEST_POLL_INTERVAL_MS)).toBe("10秒間隔");
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

describe("describeAutoRefreshState", () => {
  it("自動更新している間は間隔を出す", () => {
    expect(describeAutoRefreshState(ISSUE_POLL_INTERVAL_MS)).toBe("自動更新10秒間隔");
    expect(describeAutoRefreshState(60_000)).toBe("自動更新1分間隔");
  });

  // 何も出さないと「自動更新していない」のか「この画面は状態を出さない」のかを
  // 見分けられない（#1797）
  it("自動更新していないときも黙らず「手動更新のみ」と出す", () => {
    expect(describeAutoRefreshState(null)).toBe("手動更新のみ");
  });
});

describe("describeRefreshButtonHint", () => {
  it("押すと何が起きるかと、放っておいても更新されるのかの両方を出す", () => {
    expect(describeRefreshButtonHint(PULL_REQUEST_POLL_INTERVAL_MS)).toBe(
      "今すぐ更新（自動更新10秒間隔）",
    );
    expect(describeRefreshButtonHint(null)).toBe("今すぐ更新（手動更新のみ）");
  });
});
