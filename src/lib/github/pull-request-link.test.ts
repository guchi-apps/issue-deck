import { describe, expect, it } from "vitest";

import { extractPullRequestLinks } from "@/lib/github/pull-request-link";
import type { IssueComment } from "@/types/issue";

function comment(body: string): IssueComment {
  return {
    id: `comment-${body.length}-${body.slice(0, 8)}`,
    author: { login: "claude-code" },
    createdAtLabel: "2026-08-14",
    body,
    reactionCount: 0,
  };
}

describe("extractPullRequestLinks", () => {
  it("コメント本文のPR URLを抽出する", () => {
    const comments = [comment("実装しました: https://github.com/m-guchi/issue-deck/pull/616")];
    expect(extractPullRequestLinks(comments, "m-guchi", "issue-deck")).toEqual([
      { url: "https://github.com/m-guchi/issue-deck/pull/616", number: 616 },
    ]);
  });

  it("複数のPRが言及されている場合は全件を番号の昇順で返す（#1339）", () => {
    const comments = [
      comment("追加分: https://github.com/m-guchi/issue-deck/pull/620"),
      comment("土台: https://github.com/m-guchi/issue-deck/pull/616"),
    ];
    expect(
      extractPullRequestLinks(comments, "m-guchi", "issue-deck").map((link) => link.number),
    ).toEqual([616, 620]);
  });

  it("同じPRが複数のコメントで言及されていても1件にまとめる（#1339）", () => {
    const comments = [
      comment("実装: https://github.com/m-guchi/issue-deck/pull/616"),
      comment("レビュー完了: https://github.com/m-guchi/issue-deck/pull/616"),
    ];
    expect(extractPullRequestLinks(comments, "m-guchi", "issue-deck")).toHaveLength(1);
  });

  it("1つのコメントに複数のPR URLがあっても全件拾う", () => {
    const comments = [
      comment(
        "https://github.com/m-guchi/issue-deck/pull/616 と https://github.com/m-guchi/issue-deck/pull/620",
      ),
    ];
    expect(
      extractPullRequestLinks(comments, "m-guchi", "issue-deck").map((link) => link.number),
    ).toEqual([616, 620]);
  });

  it("別リポジトリのPR URLは除外する", () => {
    const comments = [comment("https://github.com/other-owner/other-repo/pull/616")];
    expect(extractPullRequestLinks(comments, "m-guchi", "issue-deck")).toEqual([]);
  });

  it("Issue URLはPRとして拾わない", () => {
    const comments = [comment("https://github.com/m-guchi/issue-deck/issues/616")];
    expect(extractPullRequestLinks(comments, "m-guchi", "issue-deck")).toEqual([]);
  });

  it("該当リンクが無ければ空配列を返す", () => {
    expect(extractPullRequestLinks([comment("特に何も無い")], "m-guchi", "issue-deck")).toEqual([]);
  });
});
