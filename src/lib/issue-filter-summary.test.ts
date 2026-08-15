import { describe, expect, it } from "vitest";

import {
  clearIssueFilterConditions,
  countActiveIssueFilters,
  type IssueFilterConditions,
} from "@/lib/issue-filter-summary";

const none: IssueFilterConditions = { state: "open", labels: [], assignee: null };

describe("countActiveIssueFilters", () => {
  it("ビューの既定と同じ条件だけなら0を返す", () => {
    expect(countActiveIssueFilters({ ...none }, "all")).toBe(0);
  });

  it("状態がビューの既定と違うときだけ1件として数える", () => {
    expect(countActiveIssueFilters({ ...none, state: "closed" }, "all")).toBe(1);
    // 「直近本番に反映した」の既定はallなので、allは絞り込みではない
    expect(countActiveIssueFilters({ ...none, state: "all" }, "recently-merged")).toBe(0);
    expect(countActiveIssueFilters({ ...none, state: "open" }, "recently-merged")).toBe(1);
  });

  it("ラベルは選択した数だけ、担当者は1件として数える", () => {
    expect(
      countActiveIssueFilters(
        { state: "open", labels: ["30.bug", "62.design"], assignee: "guchi" },
        "all",
      ),
    ).toBe(3);
  });
});

describe("clearIssueFilterConditions", () => {
  it("状態・ラベル・担当者を既定へ戻し、それ以外の値は残す", () => {
    const cleared = clearIssueFilterConditions(
      { state: "closed", labels: ["30.bug"], assignee: "guchi", sort: "updated" as const },
      "all",
    );

    expect(cleared).toEqual({ state: "open", labels: [], assignee: null, sort: "updated" });
    expect(countActiveIssueFilters(cleared, "all")).toBe(0);
  });

  it("状態はビューごとの既定へ戻す", () => {
    const cleared = clearIssueFilterConditions(
      { state: "open", labels: [], assignee: null },
      "recently-merged",
    );

    expect(cleared.state).toBe("all");
  });
});
