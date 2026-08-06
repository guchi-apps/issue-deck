import { describe, expect, it } from "vitest";

import {
  extractCrossReferencedPullRequestLink,
  type GithubApiTimelineEvent,
} from "@/lib/github/pull-request-timeline";

function crossReferencedEvent(
  overrides: Partial<{
    number: number;
    html_url: string;
    isPullRequest: boolean;
    repositoryFullName: string;
  }> = {},
): GithubApiTimelineEvent {
  const {
    number = 616,
    html_url = "https://github.com/m-guchi/issue-deck/pull/616",
    isPullRequest = true,
    repositoryFullName,
  } = overrides;
  return {
    event: "cross-referenced",
    source: {
      type: "issue",
      issue: {
        number,
        html_url,
        pull_request: isPullRequest ? {} : undefined,
        repository: repositoryFullName ? { full_name: repositoryFullName } : undefined,
      },
    },
  };
}

describe("extractCrossReferencedPullRequestLink", () => {
  it("同一リポジトリのPRからのcross-referenceを抽出する", () => {
    const events = [crossReferencedEvent()];
    expect(extractCrossReferencedPullRequestLink(events, "m-guchi", "issue-deck")).toEqual({
      url: "https://github.com/m-guchi/issue-deck/pull/616",
      number: 616,
    });
  });

  it("複数のcross-referenceがある場合は最新（配列末尾）のものを採用する", () => {
    const events = [
      crossReferencedEvent({ number: 600, html_url: "https://github.com/m-guchi/issue-deck/pull/600" }),
      crossReferencedEvent({ number: 616, html_url: "https://github.com/m-guchi/issue-deck/pull/616" }),
    ];
    expect(extractCrossReferencedPullRequestLink(events, "m-guchi", "issue-deck")?.number).toBe(616);
  });

  it("cross-referenced以外のイベントは無視する", () => {
    const events: GithubApiTimelineEvent[] = [{ event: "labeled" }, crossReferencedEvent()];
    expect(extractCrossReferencedPullRequestLink(events, "m-guchi", "issue-deck")).not.toBeNull();
  });

  it("参照元がPRではなくIssueの場合は無視する", () => {
    const events = [crossReferencedEvent({ isPullRequest: false })];
    expect(extractCrossReferencedPullRequestLink(events, "m-guchi", "issue-deck")).toBeNull();
  });

  it("別リポジトリからのcross-referenceは無視する", () => {
    const events = [crossReferencedEvent({ repositoryFullName: "other-owner/other-repo" })];
    expect(extractCrossReferencedPullRequestLink(events, "m-guchi", "issue-deck")).toBeNull();
  });

  it("該当イベントが無ければnullを返す", () => {
    expect(extractCrossReferencedPullRequestLink([], "m-guchi", "issue-deck")).toBeNull();
  });
});
