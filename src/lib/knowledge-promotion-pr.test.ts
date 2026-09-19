import { describe, expect, it } from "vitest";

import {
  countOpenPromotionPullRequests,
  describePromotionPullRequests,
  isPromotionPullRequest,
} from "@/lib/knowledge-promotion-pr";
import type { PullRequestSummary } from "@/types/pull-request";

function pr(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    repositoryFullName: "guchi-apps/docs",
    headRef: "knowledge/promote-20260918-223656",
    state: "open",
    merged: false,
    ...overrides,
  } as PullRequestSummary;
}

describe("isPromotionPullRequest", () => {
  it("guchi-apps/docsのknowledge/promote-*だけが反映PR", () => {
    expect(isPromotionPullRequest(pr({}))).toBe(true);
    expect(isPromotionPullRequest(pr({ headRef: "issue-12" }))).toBe(false);
    expect(isPromotionPullRequest(pr({ repositoryFullName: "guchi-apps/issue-deck" }))).toBe(false);
  });
});

describe("countOpenPromotionPullRequests", () => {
  it("未取得ならnull、取得済みならopenな反映PRだけを数える", () => {
    const list = [
      pr({}),
      pr({ headRef: "knowledge/promote-2" }),
      pr({ headRef: "knowledge/promote-3", state: "closed", merged: true }),
      pr({ headRef: "issue-1" }),
    ];

    expect(countOpenPromotionPullRequests(list, false)).toBeNull();
    expect(countOpenPromotionPullRequests(list, true)).toBe(2);
    expect(countOpenPromotionPullRequests([], true)).toBe(0);
  });
});

describe("describePromotionPullRequests", () => {
  it("件数があるときだけ吹き出しを差し替える", () => {
    expect(describePromotionPullRequests("説明", 0)).toBe("説明");
    expect(describePromotionPullRequests("説明", null)).toBe("説明");
    expect(describePromotionPullRequests("説明", 2)).toContain("2件");
  });
});
