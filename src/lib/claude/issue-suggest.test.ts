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

  it("00〜09番台のラベル（ユーザーチェック・進捗管理用）は候補から除外する", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "本文",
      availableLabels: [
        { name: "00.check-user", description: "要確認" },
        { name: "01.wip", description: "作業中" },
        { name: "09.main", description: "main反映済み" },
        { name: "bug", description: "不具合" },
      ],
    });

    expect(prompt).not.toContain("00.check-user");
    expect(prompt).not.toContain("01.wip");
    expect(prompt).not.toContain("09.main");
    expect(prompt).toContain("- bug: 不具合");
  });

  it("00〜09番台のラベルのみの場合は「利用可能なラベルなし」と表示する", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "本文",
      availableLabels: [{ name: "00.check-user", description: "要確認" }],
    });

    expect(prompt).toContain("(利用可能なラベルなし)");
  });
});
