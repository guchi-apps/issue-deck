import { describe, expect, it } from "vitest";

import { markPlanChanges } from "@/lib/plan-diff";

describe("markPlanChanges", () => {
  it("前回が無ければそのまま返す", () => {
    expect(markPlanChanges(null, "- a")).toEqual({ markdown: "- a", changedCount: 0 });
  });

  it("同一なら変更0", () => {
    expect(markPlanChanges("## 要約\n- a\n- b", "## 要約\n- a\n- b").changedCount).toBe(0);
  });

  it("追加・変更行だけをinsで包み、リストの印は外に残す", () => {
    const r = markPlanChanges("- a\n- b", "- a\n- b2\n- c");
    expect(r.markdown).toBe("- a\n- <ins>b2</ins>\n- <ins>c</ins>");
    expect(r.changedCount).toBe(2);
  });

  it("見出しは#の後ろだけを包む", () => {
    expect(markPlanChanges("## a", "## b").markdown).toBe("## <ins>b</ins>");
  });

  it("表・コードブロックは対象外", () => {
    const r = markPlanChanges("x", "| a | b |\n```\nnew\n```");
    expect(r.changedCount).toBe(0);
  });

  it("同じ行が増えた場合は増えた分だけ強調する", () => {
    expect(markPlanChanges("- a", "- a\n- a").changedCount).toBe(1);
  });
});
