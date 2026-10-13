import { describe, expect, it } from "vitest";

import {
  RELEASE_REVIEW_CHECK_ITEMS,
  checklistPromptText,
  describeUnconfirmedChecks,
  normalizeCheckResults,
} from "./release-review-checklist";

describe("確認項目", () => {
  it("最低限の6観点を持つ", () => {
    expect(RELEASE_REVIEW_CHECK_ITEMS.map((i) => i.id)).toEqual([
      "pr_interaction",
      "auth_boundary",
      "host_compat",
      "config_migration",
      "state_consistency",
      "ui_truthfulness",
    ]);
    expect(checklistPromptText()).toContain("host_compat");
  });

  it("報告の無い項目・未知の項目・不正な状態は未確認として揃える", () => {
    const results = normalizeCheckResults({
      raw: [
        { id: "auth_boundary", status: "confirmed", evidence: "確認した" },
        { id: "nonexistent", status: "confirmed", evidence: "x" },
        { id: "host_compat", status: "bogus", evidence: "x" },
      ],
      carryOverAllowed: false,
    });
    expect(results).toHaveLength(RELEASE_REVIEW_CHECK_ITEMS.length);
    expect(results.find((r) => r.id === "auth_boundary")?.status).toBe("confirmed");
    expect(results.find((r) => r.id === "host_compat")?.status).toBe("unconfirmed");
    expect(describeUnconfirmedChecks(results)).toContain("5件が未確認");
  });

  it("根拠の無い確認済み・非該当は未確認、重複した報告は先頭だけ使う", () => {
    const results = normalizeCheckResults({
      raw: [
        { id: "auth_boundary", status: "not_applicable" },
        { id: "pr_interaction", status: "confirmed", evidence: "a" },
        { id: "pr_interaction", status: "unconfirmed", evidence: "b" },
      ],
      carryOverAllowed: false,
    });
    expect(results.find((r) => r.id === "auth_boundary")?.status).toBe("unconfirmed");
    expect(results.find((r) => r.id === "pr_interaction")?.status).toBe("confirmed");
  });
});
