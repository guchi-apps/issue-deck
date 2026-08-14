import { describe, expect, it } from "vitest";

import { buildFollowupIssueBodyPrefix, composeIssueBody } from "@/lib/github/followup-issue";

const issue = {
  repositoryFullName: "owner/repo",
  number: 815,
  title: "複数リポジトリ間のIssue参照リンク機能の改善",
  htmlUrl: "https://github.com/owner/repo/issues/815",
};

describe("buildFollowupIssueBodyPrefix", () => {
  it("リポジトリ名・Issue番号・タイトル・URLを含む接頭辞を組み立てる", () => {
    const prefix = buildFollowupIssueBodyPrefix(issue);
    expect(prefix).toContain("owner/repo");
    expect(prefix).toContain("#815");
    expect(prefix).toContain("複数リポジトリ間のIssue参照リンク機能の改善");
    expect(prefix).toContain("https://github.com/owner/repo/issues/815");
  });

  it("元Issueのリポジトリと異なるリポジトリへ作成先を切り替えても機能するようフルURLを含める", () => {
    // #番号だけの参照だと、作成先リポジトリが元Issueと異なる場合に誤ったIssueへリンクしてしまうため、
    // rehype-linkify-issue-refsによる自動リンク化に依存しないフルURLが含まれていることを確認する。
    const prefix = buildFollowupIssueBodyPrefix(issue);
    expect(prefix).toContain(issue.htmlUrl);
  });
});

describe("composeIssueBody", () => {
  it("接頭辞が無ければ入力内容をそのまま返す", () => {
    expect(composeIssueBody(null, "やりたいこと")).toBe("やりたいこと");
    expect(composeIssueBody("", "やりたいこと")).toBe("やりたいこと");
  });

  it("接頭辞の後ろへ入力内容を連結する", () => {
    expect(composeIssueBody(buildFollowupIssueBodyPrefix(issue), "やりたいこと")).toBe(
      `${buildFollowupIssueBodyPrefix(issue)}やりたいこと`,
    );
  });

  it("接頭辞が空行で終わっていない場合でも、間に空行を1つ挟む", () => {
    expect(composeIssueBody("引き継ぎ元", "やりたいこと")).toBe("引き継ぎ元\n\nやりたいこと");
    expect(composeIssueBody("引き継ぎ元\n", "やりたいこと")).toBe("引き継ぎ元\n\nやりたいこと");
  });

  it("入力が空の場合は接頭辞の末尾の空行を残さない", () => {
    expect(composeIssueBody("引き継ぎ元\n\n", "")).toBe("引き継ぎ元");
    expect(composeIssueBody("引き継ぎ元\n\n", "   \n")).toBe("引き継ぎ元");
  });
});
