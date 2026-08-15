import { describe, expect, it } from "vitest";

import { selectSummaryLabels } from "@/lib/issue-summary-labels";
import type { IssueLabel } from "@/types/issue";

function label(name: string): IssueLabel {
  return { name, color: "cccccc", description: null };
}

describe("selectSummaryLabels", () => {
  it("上限以下ならすべて出し、隠した件数は0になる", () => {
    const result = selectSummaryLabels([label("62.design"), label("11.local")]);
    expect(result.visible.map((l) => l.name)).toEqual(["62.design", "11.local"]);
    expect(result.hiddenCount).toBe(0);
  });

  it("上限を超えたぶんは隠し、件数を返す", () => {
    const result = selectSummaryLabels(
      [label("62.design"), label("11.local"), label("80.Priority: High"), label("71.manual-step")],
      3,
    );
    expect(result.visible).toHaveLength(3);
    expect(result.hiddenCount).toBe(1);
  });

  it("要対応ラベルは切り捨てられないよう先頭へ寄せる", () => {
    const result = selectSummaryLabels(
      [
        label("62.design"),
        label("11.local"),
        label("80.Priority: High"),
        label("00.check-user"),
        label("01.check-merge"),
      ],
      3,
    );
    expect(result.visible.map((l) => l.name)).toEqual([
      "00.check-user",
      "01.check-merge",
      "62.design",
    ]);
    expect(result.hiddenCount).toBe(2);
  });

  it("同順位のラベルは元の順序を保つ", () => {
    const result = selectSummaryLabels([label("62.design"), label("11.local")], 2);
    expect(result.visible.map((l) => l.name)).toEqual(["62.design", "11.local"]);
  });

  it("ラベルが無ければ空で返す", () => {
    expect(selectSummaryLabels([])).toEqual({ visible: [], hiddenCount: 0 });
  });
});
