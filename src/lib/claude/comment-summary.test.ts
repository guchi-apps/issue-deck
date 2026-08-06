import { describe, expect, it } from "vitest";

import { buildCommentSummaryPrompt } from "@/lib/claude/comment-summary";

describe("buildCommentSummaryPrompt", () => {
  it("コメント本文と見出し構成を含むプロンプトを組み立てる", () => {
    const prompt = buildCommentSummaryPrompt("実装が完了しました。DBスキーマを変更したので確認をお願いします。");

    expect(prompt).toContain("## 重要な点");
    expect(prompt).toContain("## 変更点");
    expect(prompt).toContain("## 懸念点");
    expect(prompt).toContain("実装が完了しました。DBスキーマを変更したので確認をお願いします。");
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildCommentSummaryPrompt(longBody);

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length + 500);
  });
});
