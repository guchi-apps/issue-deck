import { describe, expect, it } from "vitest";

import { buildAskRepoQuestionTitle } from "@/components/dashboard/ask-repo-question-dialog";

describe("buildAskRepoQuestionTitle", () => {
  it("質問文の先頭に「[質問] 」を付与する", () => {
    expect(buildAskRepoQuestionTitle("このリポジトリの構成を教えて")).toBe(
      "[質問] このリポジトリの構成を教えて",
    );
  });

  it("前後の空白を取り除く", () => {
    expect(buildAskRepoQuestionTitle("  質問です  ")).toBe("[質問] 質問です");
  });

  it("改行や連続する空白を1つの半角スペースにまとめる", () => {
    expect(buildAskRepoQuestionTitle("1行目\n\n2行目   3行目")).toBe(
      "[質問] 1行目 2行目 3行目",
    );
  });

  it("40文字を超える質問は省略記号で丸める", () => {
    const long = "あ".repeat(50);
    expect(buildAskRepoQuestionTitle(long)).toBe(`[質問] ${"あ".repeat(40)}…`);
  });

  it("40文字以下の質問はそのまま使う", () => {
    const exact = "あ".repeat(40);
    expect(buildAskRepoQuestionTitle(exact)).toBe(`[質問] ${exact}`);
  });
});
