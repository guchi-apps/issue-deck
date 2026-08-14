import { describe, expect, it } from "vitest";

import {
  extractCrossReferencedPullRequestLinks,
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

describe("extractCrossReferencedPullRequestLinks", () => {
  it("同一リポジトリのPRからのcross-referenceを抽出する", () => {
    const events = [crossReferencedEvent()];
    expect(extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck")).toEqual([
      { url: "https://github.com/m-guchi/issue-deck/pull/616", number: 616 },
    ]);
  });

  it("複数のcross-referenceがある場合は全件を番号の昇順で返す（#1339）", () => {
    const events = [
      crossReferencedEvent({ number: 616, html_url: "https://github.com/m-guchi/issue-deck/pull/616" }),
      crossReferencedEvent({ number: 600, html_url: "https://github.com/m-guchi/issue-deck/pull/600" }),
    ];
    expect(
      extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck").map((l) => l.number),
    ).toEqual([600, 616]);
  });

  it("同じPRが複数回参照されていても1件にまとめる（#1339）", () => {
    const events = [crossReferencedEvent(), crossReferencedEvent()];
    expect(extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck")).toHaveLength(1);
  });

  it("cross-referenced以外のイベントは無視する", () => {
    const events: GithubApiTimelineEvent[] = [{ event: "labeled" }, crossReferencedEvent()];
    expect(extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck")).toHaveLength(1);
  });

  it("参照元がPRではなくIssueの場合は無視する", () => {
    const events = [crossReferencedEvent({ isPullRequest: false })];
    expect(extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck")).toEqual([]);
  });

  it("別リポジトリからのcross-referenceは無視する", () => {
    const events = [crossReferencedEvent({ repositoryFullName: "other-owner/other-repo" })];
    expect(extractCrossReferencedPullRequestLinks(events, "m-guchi", "issue-deck")).toEqual([]);
  });

  it("該当イベントが無ければ空配列を返す", () => {
    expect(extractCrossReferencedPullRequestLinks([], "m-guchi", "issue-deck")).toEqual([]);
  });
});
