import { describe, expect, it } from "vitest";

import { buildCrossRepoIssueDraft, groupCrossRepoByRepository, normalizeCrossRepoUnverified } from "./release-review-cross-repo";

describe("他リポジトリが理由の未確認（#5378）", () => {
  it("相手リポジトリの形でないもの・確認項目の外の値は捨て、同じ相手と項目は1件にまとめる", () => {
    const items = normalizeCrossRepoUnverified(
      [
        { repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "u", reason: "r" },
        { repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "重複", reason: "" },
        { repository: "https://example.com/x", checkId: null },
        { repository: "guchi-apps/kurashio", checkId: "unknown_check" },
        "guchi-apps/aide",
      ],
      null,
    );
    expect(items).toEqual([
      { repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "u", reason: "r" },
      { repository: "guchi-apps/kurashio", checkId: null, usage: "", reason: "" },
    ]);
    expect(normalizeCrossRepoUnverified(undefined, null)).toEqual([]);
  });

  it("確認済み・非該当の項目を理由にしたものは落とす", () => {
    const checks = [
      { id: "pr_interaction", status: "confirmed" },
      { id: "ui_truthfulness", status: "unconfirmed" },
    ];
    const items = normalizeCrossRepoUnverified(
      [
        { repository: "o/a", checkId: "pr_interaction" },
        { repository: "o/a", checkId: "ui_truthfulness" },
      ],
      checks,
    );
    expect(items.map((i) => i.checkId)).toEqual(["ui_truthfulness"]);
  });

  it("相手ごとにまとめ、題名・本文を埋めた起票画面と既存Issueの検索画面を作る", () => {
    const groups = groupCrossRepoByRepository([
      { repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "MCP asset_manager_subscriptions", reason: "category削除の影響" },
      { repository: "Guchi-Apps/AIDE", checkId: null, usage: "", reason: "" },
    ]);
    expect(groups).toHaveLength(1);
    const draft = buildCrossRepoIssueDraft({
      repository: groups[0].repository,
      items: groups[0].items,
      sourceRepository: "guchi-apps/asset-manager",
      pullRequestNumber: 1371,
    });
    expect(draft.title).toContain("guchi-apps/asset-manager#1371");
    expect(draft.body).toContain("MCP asset_manager_subscriptions");
    expect(draft.body).toContain("category削除の影響");
    const url = new URL(draft.newIssueUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/guchi-apps/aide/issues/new");
    expect(url.searchParams.get("title")).toBe(draft.title);
    expect(url.searchParams.get("body")).toBe(draft.body);
    expect(new URL(draft.searchUrl).searchParams.get("q")).toBe("is:issue is:open asset-manager 1371");
  });
});
