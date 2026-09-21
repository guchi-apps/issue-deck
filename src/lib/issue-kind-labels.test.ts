import { describe, expect, it } from "vitest";

import type { IssueLabel } from "@/types/issue";
import { isKindLabel, selectKindLabels } from "@/lib/issue-kind-labels";

const label = (name: string): IssueLabel => ({ name, color: "0052cc", description: null });

describe("isKindLabel（#3285）", () => {
  it("30〜69番台だけが種類ラベル", () => {
    expect(isKindLabel("29.x")).toBe(false);
    expect(isKindLabel("30.bug")).toBe(true);
    expect(isKindLabel("50.feature")).toBe(true);
    expect(isKindLabel("69.x")).toBe(true);
    expect(isKindLabel("70.needs-decision")).toBe(false);
  });

  it("要対応・実行オプション・優先度・Closeは種類ではない", () => {
    for (const name of [
      "00.check-user",
      "01.check-plan",
      "11.local",
      "21.plan-required",
      "25.artifact-required",
      "71.manual-step",
      "80.Priority: High",
      "90.Close: another",
    ]) {
      expect(isKindLabel(name)).toBe(false);
    }
  });

  it("番号プレフィックスの無いラベルは対象外", () => {
    expect(isKindLabel("bug")).toBe(false);
    expect(isKindLabel("enhancement")).toBe(false);
    expect(isKindLabel("5.feature")).toBe(false);
    expect(isKindLabel("350.feature")).toBe(false);
  });
});

describe("selectKindLabels（#3285）", () => {
  it("種類ラベルだけを番号順に返す", () => {
    const result = selectKindLabels([
      label("62.design"),
      label("11.local"),
      label("30.bug"),
      label("80.Priority: High"),
      label("51.improvement"),
    ]);
    expect(result.map((l) => l.name)).toEqual(["30.bug", "51.improvement", "62.design"]);
  });

  it("元の配列を書き換えない", () => {
    const input = [label("62.design"), label("30.bug")];
    selectKindLabels(input);
    expect(input.map((l) => l.name)).toEqual(["62.design", "30.bug"]);
  });

  it("種類ラベルが無ければ空配列", () => {
    expect(selectKindLabels([label("11.local"), label("bug")])).toEqual([]);
  });
});
