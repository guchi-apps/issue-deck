import { describe, expect, it } from "vitest";

import { buildIssueSummaryPrompt } from "@/lib/claude/issue-summary";

describe("buildIssueSummaryPrompt", () => {
  it("タイトル・本文・コメントを含むプロンプトを組み立てる", () => {
    const prompt = buildIssueSummaryPrompt({
      title: "ログインできない",
      body: "特定条件でログインに失敗する",
      comments: [{ author: "alice", body: "再現しました" }],
    });

    expect(prompt).toContain("ログインできない");
    expect(prompt).toContain("特定条件でログインに失敗する");
    expect(prompt).toContain("### コメント1 (alice)");
    expect(prompt).toContain("再現しました");
  });

  it("コメントが無い場合は「コメントなし」と表示する", () => {
    const prompt = buildIssueSummaryPrompt({ title: "タイトル", body: "本文", comments: [] });

    expect(prompt).toContain("(コメントなし)");
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildIssueSummaryPrompt({ title: "タイトル", body: longBody, comments: [] });

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length + 1000);
  });

  it("個々のコメントが長大な場合は切り詰める", () => {
    const longComment = "い".repeat(3000);
    const prompt = buildIssueSummaryPrompt({
      title: "タイトル",
      body: "本文",
      comments: [{ author: "bob", body: longComment }],
    });

    const commentSection = prompt.split("### コメント1")[1];
    expect(commentSection).toContain("...(省略)");
    expect(commentSection.length).toBeLessThan(longComment.length);
  });

  it("コメント件数が上限を超える場合は古いものから省略し、件数を注記する", () => {
    const comments = Array.from({ length: 35 }, (_, i) => ({
      author: `user${i}`,
      body: `コメント本文${i}`,
    }));
    const prompt = buildIssueSummaryPrompt({ title: "タイトル", body: "本文", comments });

    expect(prompt).toContain("(古い5件のコメントは省略されています)");
    // 古い5件（user0〜user4）は含まれない
    expect(prompt).not.toContain("(user0)");
    // 直近のコメントは含まれる
    expect(prompt).toContain("(user34)");
  });
});
