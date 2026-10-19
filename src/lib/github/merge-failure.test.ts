import { describe, expect, it } from "vitest";

import { describeCheckState, describeMergeFailure, githubMessageOf, requiredCheckNameOf } from "@/lib/github/merge-failure";

const body = (message: string) => JSON.stringify({ message, documentation_url: "https://docs.github.com/rest" });

describe("describeMergeFailure（#4878）", () => {
  it("ルールセットの必須チェック待ちは、チェック名・いまの状態・Auto-mergeの見通しを出す", () => {
    const raw = body('Repository rule violations found\n\nRequired status check "issue-deck/ios-precheck" is expected.\n\n');
    expect(requiredCheckNameOf(raw)).toBe("issue-deck/ios-precheck");
    const failure = describeMergeFailure({
      status: 405,
      body: raw,
      pullRequest: { state: "open", autoMerge: true, baseRef: "develop" },
      check: { state: "pending", description: "iOS修復待ち: 同じPRのセッション yoteiflow-issue-1281 が稼働中です" },
    });
    expect(failure).toMatchObject({
      kind: "required_check",
      title: "必須チェックがまだ成功していないため、マージできません",
      reason: "「develop」のルールで、チェック「issue-deck/ios-precheck」の成功がマージの条件になっています。",
      next: "Auto-mergeが有効なので、チェックが成功すれば自動でマージされます。",
      checkName: "issue-deck/ios-precheck",
      httpStatus: 405,
    });
    expect(failure.githubMessage).toContain("Repository rule violations found");
    expect(failure.githubMessage).not.toContain("https://");
    expect(describeCheckState(failure.check!)).toBe("待機中: iOS修復待ち: 同じPRのセッション yoteiflow-issue-1281 が稼働中です");
  });

  it("必須チェックが失敗しているなら、Auto-mergeが有効でも直すよう案内する", () => {
    const failure = describeMergeFailure({
      status: 405,
      body: body('Required status check "lint-and-build" is failing.'),
      pullRequest: { autoMerge: true },
      check: { state: "failure", description: null },
    });
    expect(failure.next).toBe("チェックの失敗を直してから、もう一度マージしてください。");
  });

  it("名前の無い必須チェックの言い回しも必須チェックとして扱う", () => {
    const failure = describeMergeFailure({ status: 405, body: body("2 of 3 required status checks are expected.") });
    expect(failure.kind).toBe("required_check");
    expect(failure.checkName).toBeNull();
  });

  it.each([
    ["At least 1 approving review is required by reviewers with write access.", "review_required", "承認レビューがあと1件必要です"],
    ["Merge commits are not allowed on this repository.", "merge_method_not_allowed", "このリポジトリではマージコミットでのマージが禁止されています"],
    ["Base branch was modified. Review and try the merge again.", "base_modified", "マージ先のブランチが直前に更新されました"],
    ["Pull Request is not mergeable", "not_mergeable", "GitHubがまだマージできない状態と判定しています"],
    ["Pull request is in draft state", "draft", "ドラフトのPRはマージできません"],
  ])("405 %s", (message, kind, title) => {
    expect(describeMergeFailure({ status: 405, body: body(message) })).toMatchObject({ kind, title });
  });

  it("409（HEADの食い違い）は確認し直すよう案内する", () => {
    expect(describeMergeFailure({ status: 409, body: body("Head branch was modified. Review and try the merge again.") }).kind).toBe(
      "head_modified",
    );
  });

  it("403は権限不足として出す", () => {
    expect(describeMergeFailure({ status: 403, body: body("Resource not accessible by integration") }).kind).toBe("forbidden");
  });

  it("PRがすでにマージ済みなら、GitHubの文言より先にそれを言う", () => {
    const failure = describeMergeFailure({ status: 405, body: body("Pull Request is not mergeable"), pullRequest: { state: "closed", merged: true } });
    expect(failure).toMatchObject({ kind: "already_closed", title: "このPRはすでにマージされています" });
  });

  it("ルールセットのその他の違反は、違反の行を理由に並べる", () => {
    const failure = describeMergeFailure({
      status: 405,
      body: body("Repository rule violations found\n\nChanges must be made through the merge queue\n\n"),
    });
    expect(failure).toMatchObject({ kind: "rule_violation", reason: "Changes must be made through the merge queue" });
  });

  it("どれにも当たらなければHTTPステータスと原文の要点を出す", () => {
    const failure = describeMergeFailure({ status: 422, body: body("Something unexpected happened") });
    expect(failure).toMatchObject({
      kind: "unknown",
      title: "GitHubがマージを受け付けませんでした（HTTP 422）",
      reason: "Something unexpected happened",
    });
  });
});

describe("githubMessageOf", () => {
  it("JSONでない本文はそのまま、空ならnull", () => {
    expect(githubMessageOf("Bad gateway")).toBe("Bad gateway");
    expect(githubMessageOf("")).toBeNull();
    expect(githubMessageOf(undefined)).toBeNull();
  });
});
