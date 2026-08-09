import { describe, expect, it } from "vitest";

import { extractLinkedIssueNumbers } from "@/lib/github/release-pr-issue-link";

describe("extractLinkedIssueNumbers", () => {
  it("本文中の複数の#数字を抽出する", () => {
    expect(extractLinkedIssueNumbers("タイトル", "#123 と #456 に対応")).toEqual([123, 456]);
  });

  it("タイトル・本文の両方から抽出する", () => {
    expect(extractLinkedIssueNumbers("#111 対応", "#222 も含む")).toEqual([111, 222]);
  });

  it("重複する番号は1つにまとめる", () => {
    expect(extractLinkedIssueNumbers("タイトル", "#123 と #123")).toEqual([123]);
  });

  it("closesなどのクローズキーワード付きでも拾える", () => {
    expect(extractLinkedIssueNumbers("タイトル", "closes #789")).toEqual([789]);
  });

  it("該当箇所が無ければ空配列を返す", () => {
    expect(extractLinkedIssueNumbers("タイトル", "本文のみ")).toEqual([]);
  });

  it("本文がnullでも空配列を返す", () => {
    expect(extractLinkedIssueNumbers("タイトル", null)).toEqual([]);
  });

  it("URLフラグメント識別子（#の直後が英字）は誤マッチしない", () => {
    expect(
      extractLinkedIssueNumbers("タイトル", "https://example.com/foo#discussion_r123 や #L10"),
    ).toEqual([]);
  });
});
