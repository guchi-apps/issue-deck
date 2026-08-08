import { describe, expect, it } from "vitest";

import { mergeSuggestedLabels } from "@/components/dashboard/create-issue-dialog";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";

describe("mergeSuggestedLabels", () => {
  it("これまでに選択済みのラベルを一度リセットしてから、生成結果のラベルへ置き換える", () => {
    const prev = ["bug", "enhancement"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["60.chore"]);
  });

  it("実装オプション用ラベル（チェックボックス選択分）はリセットせず維持する", () => {
    const prev = ["bug", PLAN_REQUIRED_LABEL];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual([PLAN_REQUIRED_LABEL, "60.chore"]);
  });

  it("進捗管理用ラベルはリセットせず維持する", () => {
    const prev = ["bug", "02.wip"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["02.wip", "60.chore"]);
  });

  it("生成結果に重複があっても1つにまとめる", () => {
    expect(mergeSuggestedLabels([], ["60.chore", "60.chore"])).toEqual(["60.chore"]);
  });
});
