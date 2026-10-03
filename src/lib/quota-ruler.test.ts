import { describe, expect, it } from "vitest";

import { buildWindowTimeline, optionFromRatio, stepOption } from "@/lib/quota-ruler";

const OPTIONS = [30, 45, 60, 90, 120];

describe("optionFromRatio", () => {
  it("バーの位置（右端からの割合）に最も近い選択肢へ吸着する", () => {
    // 右端0・左端300分: 割合0.2→60分、0.1→30分、0.4→120分
    expect(optionFromRatio(OPTIONS, 0.2, 300)).toBe(60);
    expect(optionFromRatio(OPTIONS, 0.1, 300)).toBe(30);
    expect(optionFromRatio(OPTIONS, 0.28, 300)).toBe(90);
  });

  it("バーの外は端の選択肢になる", () => {
    expect(optionFromRatio(OPTIONS, -1, 300)).toBe(30);
    expect(optionFromRatio(OPTIONS, 5, 300)).toBe(120);
  });
});

describe("stepOption", () => {
  it("隣へ動き、端では動かない", () => {
    expect(stepOption(OPTIONS, 60, 1)).toBe(90);
    expect(stepOption(OPTIONS, 60, -1)).toBe(45);
    expect(stepOption(OPTIONS, 30, -1)).toBe(30);
    expect(stepOption(OPTIONS, 120, 1)).toBe(120);
  });
});

describe("buildWindowTimeline", () => {
  const resetsAt = "2026-09-17T23:40:00.000Z";
  const resetsMs = new Date(resetsAt).getTime();

  it("いまと起動位置を5時間の帯の割合で返す", () => {
    // 残り60分 → 起動は帯の80%、いまは残り120分 → 60%
    const timeline = buildWindowTimeline(resetsAt, resetsMs - 120 * 60_000, 60);
    expect(timeline?.nowPercent).toBeCloseTo(60);
    expect(timeline?.launchPercent).toBeCloseTo(80);
    expect(timeline?.launchAtIso).toBe("2026-09-17T22:40:00.000Z");
  });

  it("いまが未取得ならnowPercentはnull", () => {
    expect(buildWindowTimeline(resetsAt, null, 60)?.nowPercent).toBeNull();
  });

  it("不正な時刻はnull", () => {
    expect(buildWindowTimeline("invalid", 0, 60)).toBeNull();
  });
});
