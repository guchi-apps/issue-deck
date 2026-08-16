import { describe, expect, it } from "vitest";
import {
  calcElapsedTimePercent,
  calcRemainingTimePercent,
  formatResetAt,
  formatResetCountdown,
  formatResetSentence,
} from "@/lib/format-reset";

// ローカルタイムで解釈させるためタイムゾーン指定なしで生成する。
// 2026-08-04は火曜日。
const NOW_MS = new Date(2026, 7, 4, 12, 0, 0).getTime();
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
    expect(formatResetCountdown(afterMinutes(134), NOW_MS)).toBe("あと2時間14分");
  });

  it("ちょうどの時間は分を省く", () => {
    expect(formatResetCountdown(afterMinutes(120), NOW_MS)).toBe("あと2時間");
  });

  it("24時間以上は日で表示する", () => {
    expect(formatResetCountdown(afterMinutes(3 * 24 * 60 + 240), NOW_MS)).toBe("あと3日4時間");
    expect(formatResetCountdown(afterMinutes(3 * 24 * 60), NOW_MS)).toBe("あと3日");
  });

  it("経過済みならリセット間近として扱う", () => {
    expect(formatResetCountdown(afterMinutes(-60), NOW_MS)).toBe("まもなくリセット");
  });

  it("数値でない値はnullを返す", () => {
    expect(formatResetCountdown(Number.NaN, NOW_MS)).toBeNull();
  });
});

describe("formatResetSentence", () => {
  it("残り時間に「でリセット」を添える", () => {
    expect(formatResetSentence(afterMinutes(134), NOW_MS)).toBe("あと2時間14分でリセット");
  });

  it("経過済みなら「でリセット」を重ねない", () => {
    expect(formatResetSentence(afterMinutes(-60), NOW_MS)).toBe("まもなくリセット");
  });

  it("数値でない値はnullを返す", () => {
    expect(formatResetSentence(Number.NaN, NOW_MS)).toBeNull();
  });
});

describe("formatResetAt", () => {
  it("同じ日なら時刻と残り時間だけを出す", () => {
    // 12:00の2時間14分後 = 14:14
    expect(formatResetAt(afterMinutes(134), NOW_MS)).toBe("14:14 (あと2時間14分)");
  });

  it("分は2桁に揃え、時は揃えない", () => {
    const at13 = new Date(2026, 7, 4, 13, 0, 0).getTime() / 1000;
    expect(formatResetAt(at13, NOW_MS)).toBe("13:00 (あと1時間)");
  });

  it("日をまたぐ場合は曜日を添える", () => {
    // 2026-08-04(火)の12:00から3日4時間後 = 2026-08-07(金)の16:00
    expect(formatResetAt(afterMinutes(3 * 24 * 60 + 240), NOW_MS)).toBe(
      "金曜日 16:00 (あと3日4時間)",
    );
  });

  it("翌日であれば5時間枠でも曜日を添える", () => {
    const nextDayEarly = new Date(2026, 7, 5, 4, 0, 0).getTime() / 1000;
    expect(formatResetAt(nextDayEarly, NOW_MS)).toBe("水曜日 4:00 (あと16時間)");
  });

  it("数値でない値はnullを返す", () => {
    expect(formatResetAt(Number.NaN, NOW_MS)).toBeNull();
  });
});

describe("calcRemainingTimePercent", () => {
  const HOUR_MS = 60 * 60_000;

  it("ウィンドウ中間なら50%になる", () => {
    expect(calcRemainingTimePercent(afterMinutes(30), HOUR_MS, NOW_MS)).toBeCloseTo(50);
  });

  it("リセット直後(開始時点)なら100%になる", () => {
    expect(calcRemainingTimePercent(afterMinutes(60), HOUR_MS, NOW_MS)).toBeCloseTo(100);
  });

  it("リセット時点なら0%になる", () => {
    expect(calcRemainingTimePercent(afterMinutes(0), HOUR_MS, NOW_MS)).toBeCloseTo(0);
  });

  it("リセット経過後は0%に丸める", () => {
    expect(calcRemainingTimePercent(afterMinutes(-30), HOUR_MS, NOW_MS)).toBe(0);
  });

  it("ウィンドウ長を超える残り時間は100%に丸める", () => {
    expect(calcRemainingTimePercent(afterMinutes(120), HOUR_MS, NOW_MS)).toBe(100);
  });

  it("数値でない値はnullを返す", () => {
    expect(calcRemainingTimePercent(Number.NaN, HOUR_MS, NOW_MS)).toBeNull();
    expect(calcRemainingTimePercent(afterMinutes(30), Number.NaN, NOW_MS)).toBeNull();
  });

  it("ウィンドウ長が0以下ならnullを返す", () => {
    expect(calcRemainingTimePercent(afterMinutes(30), 0, NOW_MS)).toBeNull();
  });
});

describe("calcElapsedTimePercent", () => {
  const HOUR_MS = 60 * 60_000;

  it("ウィンドウ開始時点なら0%になる", () => {
    expect(calcElapsedTimePercent(afterMinutes(60), HOUR_MS, NOW_MS)).toBeCloseTo(0);
  });

  it("ウィンドウ中間なら50%になる", () => {
    expect(calcElapsedTimePercent(afterMinutes(30), HOUR_MS, NOW_MS)).toBeCloseTo(50);
  });

  it("リセット時点なら100%になる", () => {
    expect(calcElapsedTimePercent(afterMinutes(0), HOUR_MS, NOW_MS)).toBeCloseTo(100);
  });

  it("数値でない値はnullを返す", () => {
    expect(calcElapsedTimePercent(Number.NaN, HOUR_MS, NOW_MS)).toBeNull();
  });
});
