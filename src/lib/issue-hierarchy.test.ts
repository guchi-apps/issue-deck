import { describe, expect, it } from "vitest";
import {
  buildIssueHierarchy,
  parseParentIssueUrl,
  resolveIssueHierarchyBadges,
} from "@/lib/issue-hierarchy";

const PARENT_URL = "https://api.github.com/repos/guchi-apps/issue-deck/issues/12";

describe("parseParentIssueUrl", () => {
  it("APIのURLから親を取り出す", () => {
    expect(parseParentIssueUrl(PARENT_URL)).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 12,
    });
  });
  it("空・想定外の形はnull", () => {
    expect(parseParentIssueUrl(null)).toBeNull();
    expect(parseParentIssueUrl("https://example.com/x")).toBeNull();
  });
});

describe("buildIssueHierarchy", () => {
  it("親子のどちらでもなければundefined", () => {
    expect(buildIssueHierarchy(0, 0, null)).toBeUndefined();
    expect(buildIssueHierarchy(undefined, undefined, undefined)).toBeUndefined();
  });
  it("子を持てばchildren、親を持てばparentが入る", () => {
    expect(buildIssueHierarchy(3, 1, PARENT_URL)).toEqual({
      children: { total: 3, completed: 1 },
      parent: { repositoryFullName: "guchi-apps/issue-deck", number: 12 },
    });
  });
});

describe("resolveIssueHierarchyBadges", () => {
  const base = { repositoryFullName: "guchi-apps/issue-deck" };
  it("関係が無ければ空", () => {
    expect(resolveIssueHierarchyBadges({ ...base })).toEqual([]);
  });
  it("親Issueは完了数付きの「親」バッジ", () => {
    const [badge] = resolveIssueHierarchyBadges({
      ...base,
      hierarchy: { children: { total: 4, completed: 1 }, parent: null },
    });
    expect(badge.kind).toBe("parent");
    expect(badge.label).toBe("親 1/4");
  });
  it("同じリポジトリの親は番号だけ、別リポジトリはリポジトリ名付き", () => {
    const same = resolveIssueHierarchyBadges({
      ...base,
      hierarchy: { children: null, parent: { repositoryFullName: "guchi-apps/issue-deck", number: 5 } },
    });
    expect(same[0].label).toBe("子 ↑#5");
    const other = resolveIssueHierarchyBadges({
      ...base,
      hierarchy: { children: null, parent: { repositoryFullName: "guchi-apps/vps", number: 5 } },
    });
    expect(other[0].label).toBe("子 ↑vps#5");
  });
});
