import { describe, expect, it } from "vitest";

import { buildIssueSuggestPrompt } from "@/lib/claude/issue-suggest";

describe("buildIssueSuggestPrompt", () => {
  it("本文とラベル一覧（名前・説明）を含むプロンプトを組み立てる", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "特定条件でログインに失敗する",
      availableLabels: [
        { name: "bug", description: "不具合" },
        { name: "enhancement", description: null },
      ],
    });

    expect(prompt).toContain("特定条件でログインに失敗する");
    expect(prompt).toContain("- bug: 不具合");
    expect(prompt).toContain("- enhancement");
  });

  it("ラベルが無い場合は「利用可能なラベルなし」と表示する", () => {
    const prompt = buildIssueSuggestPrompt({ body: "本文", availableLabels: [] });

    expect(prompt).toContain("(利用可能なラベルなし)");
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildIssueSuggestPrompt({ body: longBody, availableLabels: [] });

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length + 1000);
  });
});
