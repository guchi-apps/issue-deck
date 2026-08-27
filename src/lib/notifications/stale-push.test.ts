import { describe, expect, it } from "vitest";

import { selectStalePushTags } from "@/lib/notifications/stale-push";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

const CHECK_USER_LABEL = { name: "00.check-user", color: "d93f0b", description: null };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "2195",
    number: 12,
    title: "サンプルIssue",
    state: "open",
    labels: [CHECK_USER_LABEL],
    repositoryFullName: "guchi-apps/issue-deck",
    ...overrides,
  } as unknown as Issue;
}

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#900",
    number: 900,
    title: "リリース",
    state: "open",
    repositoryFullName: "guchi-apps/issue-deck",
    ...overrides,
  } as unknown as PullRequestSummary;
}

describe("selectStalePushTags", () => {
  it("確認待ちが解けたIssueの通知を閉じる", () => {
    expect(
      selectStalePushTags({
        tags: ["check-user:2195"],
        issues: [makeIssue({ labels: [] })],
        pullRequests: [],
      }),
    ).toEqual(["check-user:2195"]);
  });

  it("closeされたIssueの通知も閉じる（ラベルの反映を待たない）", () => {
    expect(
      selectStalePushTags({
        tags: ["check-user:2195"],
        issues: [makeIssue({ state: "closed" })],
        pullRequests: [],
      }),
    ).toEqual(["check-user:2195"]);
  });

  it("まだ確認待ちのIssueの通知は残す", () => {
    expect(
      selectStalePushTags({
        tags: ["check-user:2195"],
        issues: [makeIssue()],
        pullRequests: [],
      }),
    ).toEqual([]);
  });

  it("一覧に載っていないIssueの通知は残す（判断材料が無い）", () => {
    expect(
      selectStalePushTags({
        tags: ["check-user:9999"],
        issues: [makeIssue()],
        pullRequests: [],
      }),
    ).toEqual([]);
  });

  it("Issue一覧が未取得のあいだは何も閉じない", () => {
    expect(
      selectStalePushTags({
        tags: ["check-user:2195"],
        issues: null,
        pullRequests: [],
      }),
    ).toEqual([]);
  });

  it("openなPR一覧から消えたリリースPRの通知を閉じる", () => {
    expect(
      selectStalePushTags({
        tags: ["release-merge:guchi-apps/issue-deck#900"],
        issues: [],
        pullRequests: [],
      }),
    ).toEqual(["release-merge:guchi-apps/issue-deck#900"]);
  });

  it("まだopenなリリースPRの通知は残す", () => {
    expect(
      selectStalePushTags({
        tags: ["release-merge:guchi-apps/issue-deck#900"],
        issues: [],
        pullRequests: [makePullRequest()],
      }),
    ).toEqual([]);
  });

  it("PR一覧の取得に失敗したリポジトリの通知は残す", () => {
    expect(
      selectStalePushTags({
        tags: ["release-merge:guchi-apps/issue-deck#900"],
        issues: [],
        pullRequests: [],
        failedRepositories: ["guchi-apps/issue-deck"],
      }),
    ).toEqual([]);
  });

  it("PR一覧が未取得のあいだは何も閉じない", () => {
    expect(
      selectStalePushTags({
        tags: ["release-merge:guchi-apps/issue-deck#900"],
        issues: [],
        pullRequests: null,
      }),
    ).toEqual([]);
  });

  it("知らないタグ（テスト通知など）は触らない", () => {
    expect(
      selectStalePushTags({
        tags: ["test", "issue-deck", "release-merge:こわれたid"],
        issues: [],
        pullRequests: [],
      }),
    ).toEqual([]);
  });

  it("済んだものだけをまとめて返す", () => {
    expect(
      selectStalePushTags({
        tags: [
          "check-user:2195",
          "check-user:2196",
          "release-merge:guchi-apps/issue-deck#900",
          "release-merge:guchi-apps/issue-deck#901",
        ],
        issues: [makeIssue(), makeIssue({ id: "2196", labels: [] })],
        pullRequests: [makePullRequest()],
      }),
    ).toEqual(["check-user:2196", "release-merge:guchi-apps/issue-deck#901"]);
  });
});
