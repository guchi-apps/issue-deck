import { describe, expect, it } from "vitest";

import { countCharacters, estimateReadingMinutes, formatCommentLength } from "@/lib/comment-length";

describe("countCharacters", () => {
  it("通常の文字列は文字数をそのまま返す", () => {
    expect(countCharacters("コメント本文")).toBe(6);
  });

  it("サロゲートペアの絵文字を1文字として数える", () => {
    expect(countCharacters("🎉🎉")).toBe(2);
  });

  it("改行も1文字として数える", () => {
    expect(countCharacters("あ\nい")).toBe(3);
  });

  it("空文字は0を返す", () => {
    expect(countCharacters("")).toBe(0);
  });
});

describe("estimateReadingMinutes", () => {
  it("500文字/分で丸めた分数を返す", () => {
    expect(estimateReadingMinutes(1000)).toBe(2);
    expect(estimateReadingMinutes(1200)).toBe(2);
    expect(estimateReadingMinutes(1300)).toBe(3);
  });

  it("500文字未満でも最低1分を返す", () => {
    expect(estimateReadingMinutes(1)).toBe(1);
    expect(estimateReadingMinutes(401)).toBe(1);
  });

  it("0文字以下は0分を返す", () => {
    expect(estimateReadingMinutes(0)).toBe(0);
    expect(estimateReadingMinutes(-1)).toBe(0);
  });
});

describe("formatCommentLength", () => {
  it("文字数と読了予想時間をまとめたラベルを返す", () => {
    expect(formatCommentLength("あ".repeat(1234))).toBe("1,234文字・約2分");
  });

  it("1000文字未満では桁区切りを付けない", () => {
    expect(formatCommentLength("あ".repeat(420))).toBe("420文字・約1分");
  });

  it("空文字ではnullを返す", () => {
    expect(formatCommentLength("")).toBeNull();
  });
});
