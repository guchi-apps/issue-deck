import { describe, expect, it } from "vitest";

import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";

function apiPullRequest(
  overrides: Partial<GithubApiOpenPullRequest> = {},
): GithubApiOpenPullRequest {
  return {
    number: 42,
    html_url: "https://github.com/guchi-apps/issue-deck/pull/42",
    title: "PRのタイトル",
    body: null,
    draft: false,
    state: "open",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    merged_at: null,
    user: { login: "claude" },
    base: { ref: "develop" },
    head: { ref: "issue-1260", sha: "abc123" },
    auto_merge: null,
    ...overrides,
  };
}

const repository = { fullName: "guchi-apps/issue-deck", private: false };

describe("toPullRequestSummary", () => {
  it("画面が使う形へ変換する", () => {
    const summary = toPullRequestSummary(apiPullRequest(), repository, {
      merged: false,
      ciState: "success",
    });

    expect(summary).toMatchObject({
      id: "guchi-apps/issue-deck#42",
      repositoryFullName: "guchi-apps/issue-deck",
      repositoryPrivate: false,
      number: 42,
      state: "open",
      merged: false,
      baseRef: "develop",
      headRef: "issue-1260",
      // ブランチ名からIssue対応PRと判定し、対応Issue番号まで解決する
      kind: "issue",
      linkedIssueNumber: 1260,
      autoMergeEnabled: false,
      ciState: "success",
    });
  });

  it("closedなPRとマージ済みを区別する", () => {
    const closed = toPullRequestSummary(apiPullRequest({ state: "closed" }), repository, {
      merged: false,
      ciState: "unknown",
    });
    expect(closed).toMatchObject({ state: "closed", merged: false });

    const merged = toPullRequestSummary(apiPullRequest({ state: "closed" }), repository, {
      merged: true,
      ciState: "unknown",
    });
    expect(merged).toMatchObject({ state: "closed", merged: true });
  });

  it("Auto-mergeが設定されていれば有効として扱う", () => {
    const summary = toPullRequestSummary(apiPullRequest({ auto_merge: {} }), repository, {
      merged: false,
      ciState: "pending",
    });
    expect(summary.autoMergeEnabled).toBe(true);
  });

  it("作者が取れない場合はunknownにする", () => {
    const summary = toPullRequestSummary(apiPullRequest({ user: null }), repository, {
      merged: false,
      ciState: "unknown",
    });
    expect(summary.authorLogin).toBe("unknown");
  });
});
