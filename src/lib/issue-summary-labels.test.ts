import { describe, expect, it } from "vitest";

import { selectSummaryLabels } from "@/lib/issue-summary-labels";
import type { IssueLabel } from "@/types/issue";

function label(name: string): IssueLabel {
  return { name, color: "cccccc", description: null };
}

describe("selectSummaryLabels", () => {
  it("渡したラベルをすべて返す", () => {
    const result = selectSummaryLabels([label("62.design"), label("11.local")]);
    expect(result.map((l) => l.name)).toEqual(["62.design", "11.local"]);
  });

  it("要対応ラベルは先頭へ寄せる", () => {
    const result = selectSummaryLabels([
      label("62.design"),
      label("11.local"),
      label("80.Priority: High"),
      label("00.check-user"),
      label("01.check-merge"),
    ]);
    expect(result.map((l) => l.name)).toEqual([
      "00.check-user",
      "01.check-merge",
      "62.design",
      "11.local",
      "80.Priority: High",
    ]);
  });

  it("同順位のラベルは元の順序を保つ", () => {
    const result = selectSummaryLabels([label("62.design"), label("11.local")]);
    expect(result.map((l) => l.name)).toEqual(["62.design", "11.local"]);
  });

  it("excludeAttentionを渡すと要対応ラベルを候補から外す（#2057）", () => {
    const result = selectSummaryLabels(
      [label("00.check-user"), label("01.check-merge"), label("60.chore"), label("62.design")],
      { excludeAttention: true },
    );
    expect(result.map((l) => l.name)).toEqual(["60.chore", "62.design"]);
  });

  it("ラベルが無ければ空で返す", () => {
    expect(selectSummaryLabels([])).toEqual([]);
  });
});
