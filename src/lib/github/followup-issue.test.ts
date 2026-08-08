import { describe, expect, it } from "vitest";

import { buildFollowupIssueBody } from "@/lib/github/followup-issue";

const issue = {
  repositoryFullName: "owner/repo",
  number: 815,
  title: "複数リポジトリ間のIssue参照リンク機能の改善",
  htmlUrl: "https://github.com/owner/repo/issues/815",
};

describe("buildFollowupIssueBody", () => {
  it("リポジトリ名・Issue番号・タイトル・URLを含む本文を組み立てる", () => {
    const body = buildFollowupIssueBody(issue);
    expect(body).toContain("owner/repo");
    expect(body).toContain("#815");
    expect(body).toContain("複数リポジトリ間のIssue参照リンク機能の改善");
    expect(body).toContain("https://github.com/owner/repo/issues/815");
  });

  it("元Issueのリポジトリと異なるリポジトリへ作成先を切り替えても機能するようフルURLを含める", () => {
    // #番号だけの参照だと、作成先リポジトリが元Issueと異なる場合に誤ったIssueへリンクしてしまうため、
    // rehype-linkify-issue-refsによる自動リンク化に依存しないフルURLが含まれていることを確認する。
    const body = buildFollowupIssueBody(issue);
    expect(body).toContain(issue.htmlUrl);
  });
});
