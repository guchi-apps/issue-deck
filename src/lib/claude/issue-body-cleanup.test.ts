import { describe, expect, it } from "vitest";

import { buildIssueBodyCleanupPrompt } from "@/lib/claude/issue-body-cleanup";

describe("buildIssueBodyCleanupPrompt", () => {
  it("本文を含むプロンプトを組み立てる", () => {
    const prompt = buildIssueBodyCleanupPrompt(
      "えーとログイン画面でボタン押しても反応しないんですけど",
    );

    expect(prompt).toContain("えーとログイン画面でボタン押しても反応しないんですけど");
  });

  it("情報の追加・削除・意味の変更を行わない旨の指示を含む", () => {
    const prompt = buildIssueBodyCleanupPrompt("本文");

    expect(prompt).toContain("情報の追加・削除・意味の変更は行わず");
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildIssueBodyCleanupPrompt(longBody);

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length + 1000);
  });
});
