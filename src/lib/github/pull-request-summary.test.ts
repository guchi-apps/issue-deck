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
      // 呼び出し側が渡さなければ「対応Issueに00.check-userは付いていない」扱い（#1469）
      linkedIssueCheckUser: false,
    });
  });

  it("対応Issueの00.check-userを呼び出し側から受け取る（#1469）", () => {
    const summary = toPullRequestSummary(apiPullRequest(), repository, {
      merged: false,
      ciState: "success",
      linkedIssueCheckUser: true,
    });
    expect(summary.linkedIssueCheckUser).toBe(true);
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

describe("toPullRequestSummary（レビュー判定。#2843）", () => {
  const VERIFICATION_SECTION = [
    "<!-- issue-deck-verification:start review=changes-requested risk=none -->",
    "## 検証結果",
    "",
    "- 自動レビュー: ❌ 要修正",
    "- 機械的リスク判定: 該当なし",
    "<!-- issue-deck-verification:end -->",
  ].join("\n");

  const RELEASE_TABLE = [
    "## コードレビューの検証結果",
    "",
    "| issue | PR | 自動レビュー | 機械的リスク判定 |",
    "| --- | --- | --- | --- |",
    "| #2062 | #2077 | ✅ 問題なし | 該当なし |",
    "",
    "<!-- issue-deck-review-detail:start issue=2062 -->",
    "指摘の本文",
    "<!-- issue-deck-review-detail:end -->",
  ].join("\n");

  it("PR本文の`## 検証結果`から自分ひとつぶんの判定を読む", () => {
    const summary = toPullRequestSummary(apiPullRequest({ body: VERIFICATION_SECTION }), repository, {
      merged: false,
      ciState: "success",
    });

    expect(summary.reviewVerdict?.reviewKind).toBe("changes-requested");
    expect(summary.reviewVerdict?.reviewLabel).toBe("要修正");
    // main宛ではないので、リリースPRの表は読みに行かない
    expect(summary.releaseVerification).toBeNull();
  });

  it("記録が無い本文ではnull", () => {
    const summary = toPullRequestSummary(apiPullRequest({ body: "実装しました。" }), repository, {
      merged: false,
      ciState: "success",
    });

    expect(summary.reviewVerdict).toBeNull();
  });

  it("main宛では検証結果の表も読み、レビュー本文だけを落とす", () => {
    const summary = toPullRequestSummary(
      apiPullRequest({ base: { ref: "main" }, head: { ref: "release-main/v4.19.0", sha: "abc" }, body: RELEASE_TABLE }),
      repository,
      { merged: false, ciState: "success" },
    );

    expect(summary.releaseVerification?.rows).toEqual([
      {
        issueNumber: 2062,
        issueTitle: null,
        pullRequestNumber: 2077,
        reviewKind: "ok",
        reviewLabel: "問題なし",
        riskKind: "none",
        riskLabel: "該当なし",
        // 一覧の応答を膨らませないため、指摘の本文は画面へ渡さない
        reviewBody: null,
      },
    ]);
  });
});
