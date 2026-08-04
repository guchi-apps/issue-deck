import { describe, expect, it } from "vitest";
import { formatResetCountdown } from "@/lib/claude/format-reset";

const NOW = Date.parse("2026-08-04T12:00:00Z");

describe("formatResetCountdown", () => {
  it("1時間未満は分で表示する", () => {
    expect(formatResetCountdown("2026-08-04T12:13:00Z", NOW)).toBe("あと13分");
  });

  it("時間と分を併記する", () => {
    expect(formatResetCountdown("2026-08-04T14:13:00Z", NOW)).toBe("あと2時間13分");
  });

  it("ちょうどの時間は分を省く", () => {
    expect(formatResetCountdown("2026-08-04T14:00:00Z", NOW)).toBe("あと2時間");
  });

  it("24時間以上は日で表示する", () => {
    expect(formatResetCountdown("2026-08-07T15:00:00Z", NOW)).toBe("あと3日3時間");
    expect(formatResetCountdown("2026-08-07T12:00:00Z", NOW)).toBe("あと3日");
  });

  it("経過済みならリセット間近として扱う", () => {
    expect(formatResetCountdown("2026-08-04T11:00:00Z", NOW)).toBe("まもなくリセット");
  });

  it("解釈できない値はnullを返す", () => {
    expect(formatResetCountdown("not-a-date", NOW)).toBeNull();
  });
});
