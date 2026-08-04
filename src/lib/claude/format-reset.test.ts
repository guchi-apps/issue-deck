import { describe, expect, it } from "vitest";
import { formatResetCountdown } from "@/lib/claude/format-reset";

const NOW_MS = Date.parse("2026-08-04T12:00:00Z");
const NOW_SEC = NOW_MS / 1000;

/** NOWからN分後のリセット時刻(epoch秒)。 */
function afterMinutes(minutes: number): number {
  return NOW_SEC + minutes * 60;
}

describe("formatResetCountdown", () => {
  it("1時間未満は分で表示する", () => {
    expect(formatResetCountdown(afterMinutes(13), NOW_MS)).toBe("あと13分");
  });

  it("時間と分を併記する", () => {
    expect(formatResetCountdown(afterMinutes(133), NOW_MS)).toBe("あと2時間13分");
  });

  it("ちょうどの時間は分を省く", () => {
    expect(formatResetCountdown(afterMinutes(120), NOW_MS)).toBe("あと2時間");
  });

  it("24時間以上は日で表示する", () => {
    expect(formatResetCountdown(afterMinutes(3 * 24 * 60 + 180), NOW_MS)).toBe("あと3日3時間");
    expect(formatResetCountdown(afterMinutes(3 * 24 * 60), NOW_MS)).toBe("あと3日");
  });

  it("経過済みならリセット間近として扱う", () => {
    expect(formatResetCountdown(afterMinutes(-60), NOW_MS)).toBe("まもなくリセット");
  });

  it("実レスポンスのepoch秒を解釈できる", () => {
    // 5h枠 1785876000、その30分前を現在時刻とする。
    expect(formatResetCountdown(1785876000, (1785876000 - 1800) * 1000)).toBe("あと30分");
  });

  it("数値でない値はnullを返す", () => {
    expect(formatResetCountdown(Number.NaN, NOW_MS)).toBeNull();
  });
});
