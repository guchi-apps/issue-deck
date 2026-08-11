import { describe, expect, it } from "vitest";

import {
  classifyPullRequest,
  extractLinkedIssueNumber,
  groupPullRequestsByRepository,
  needsManualMerge,
  sortOpenPullRequests,
} from "@/lib/pull-request-list";
import type { OpenPullRequest } from "@/types/pull-request";

function pullRequest(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "タイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/1",
    authorLogin: "claude",
    draft: false,
    baseRef: "develop",
    headRef: "issue-1",
    kind: "issue",
    linkedIssueNumber: 1,
    autoMergeEnabled: false,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("classifyPullRequest", () => {
  it("develop→mainはリリースPRとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "main", headRef: "develop" })).toBe("release");
  });

  it("release/vX.Y.Zブランチはバージョンバンプとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "release/v2.19.0" })).toBe(
      "version-bump",
    );
  });

  it("issue-<番号>ブランチは実装PRとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "issue-1058" })).toBe("issue");
  });

  it("規約から外れたブランチはotherになる", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "feature/foo" })).toBe("other");
    // issue-<番号>の前後に余計な文字が付くものは実装PRとみなさない
    expect(classifyPullRequest({ baseRef: "develop", headRef: "issue-1058-fix" })).toBe("other");
  });
});

describe("extractLinkedIssueNumber", () => {
  it("ブランチ名を最優先で使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "issue-1058", title: "#999 の対応", body: null }),
    ).toBe(1058);
  });

  it("ブランチ名から取れない場合はタイトルの#参照を使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "feature/foo", title: "#624 の対応", body: "#625" }),
    ).toBe(624);
  });

  it("タイトルに無ければ本文の#参照を使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "feature/foo", title: "PRのタイトル", body: "対応Issue: #625" }),
    ).toBe(625);
  });

  it("手掛かりが無ければnullを返す", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "release/v2.19.0", title: "v2.19.0", body: null }),
    ).toBeNull();
  });
});

describe("sortOpenPullRequests", () => {
  it("作成が古い順に並べる", () => {
    const sorted = sortOpenPullRequests([
      pullRequest({ number: 2, createdAt: "2026-08-03T00:00:00Z" }),
      pullRequest({ number: 1, createdAt: "2026-08-01T00:00:00Z" }),
      pullRequest({ number: 3, createdAt: "2026-08-02T00:00:00Z" }),
    ]);
    expect(sorted.map((pr) => pr.number)).toEqual([1, 3, 2]);
  });

  it("元の配列を破壊しない", () => {
    const input = [
      pullRequest({ number: 2, createdAt: "2026-08-03T00:00:00Z" }),
      pullRequest({ number: 1, createdAt: "2026-08-01T00:00:00Z" }),
    ];
    sortOpenPullRequests(input);
    expect(input.map((pr) => pr.number)).toEqual([2, 1]);
  });
});

describe("groupPullRequestsByRepository", () => {
  it("最も古いPRを持つリポジトリを先頭に並べる", () => {
    const groups = groupPullRequestsByRepository([
      pullRequest({
        repositoryFullName: "guchi-apps/dayspan",
        number: 10,
        createdAt: "2026-08-05T00:00:00Z",
      }),
      pullRequest({
        repositoryFullName: "guchi-apps/issue-deck",
        number: 20,
        createdAt: "2026-08-01T00:00:00Z",
      }),
      pullRequest({
        repositoryFullName: "guchi-apps/dayspan",
        number: 11,
        createdAt: "2026-08-02T00:00:00Z",
      }),
    ]);

    // dayspanの最古は08-02、issue-deckの最古は08-01なのでissue-deckが先
    expect(groups.map((group) => group.repositoryFullName)).toEqual([
      "guchi-apps/issue-deck",
      "guchi-apps/dayspan",
    ]);
    expect(groups[1].pullRequests.map((pr) => pr.number)).toEqual([11, 10]);
  });
});

describe("needsManualMerge", () => {
  it("CI通過済みでdraftでもAuto-merge待ちでもないPRだけtrue", () => {
    expect(needsManualMerge(pullRequest({ ciState: "success" }))).toBe(true);
  });

  it("draftはマージ対象にしない", () => {
    expect(needsManualMerge(pullRequest({ draft: true }))).toBe(false);
  });

  it("Auto-merge有効なPRは放っておけばマージされるため対象にしない", () => {
    expect(needsManualMerge(pullRequest({ autoMergeEnabled: true }))).toBe(false);
  });

  it("CIが通っていないPRは対象にしない", () => {
    expect(needsManualMerge(pullRequest({ ciState: "pending" }))).toBe(false);
    expect(needsManualMerge(pullRequest({ ciState: "failure" }))).toBe(false);
    expect(needsManualMerge(pullRequest({ ciState: "unknown" }))).toBe(false);
  });
});
