import { describe, expect, it } from "vitest";

import {
  isQaAnswerWaiting,
  resolveQuestionState,
} from "@/lib/question-attention";

type QuestionInput = Parameters<typeof resolveQuestionState>[0];

function makeQuestion(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    title: "[質問] サブPCのCPUを変えてよいか",
    qaAnswerPendingAt: null,
    hasUnreadComments: false,
    ...overrides,
  };
}

describe("resolveQuestionState", () => {
  it("質問Issueでなければnullを返す", () => {
    expect(resolveQuestionState(makeQuestion({ title: "通常のIssue" }))).toBeNull();
    expect(
      resolveQuestionState(makeQuestion({ title: "通常のIssue", hasUnreadComments: true })),
    ).toBeNull();
  });

  it("旧形式（質問: ）のタイトルも質問Issueとして扱う", () => {
    expect(resolveQuestionState(makeQuestion({ title: "質問: 旧形式" }))).toBe("confirmed");
  });

  it("回答待ちのあいだはwaitingを返す（未読でも未確認にしない）", () => {
    expect(
      resolveQuestionState(
        makeQuestion({ qaAnswerPendingAt: "2026-01-01T00:00:00.000Z", hasUnreadComments: true }),
      ),
    ).toBe("waiting");
  });

  it("回答待ちでなく未読コメントがあればunconfirmedを返す", () => {
    expect(resolveQuestionState(makeQuestion({ hasUnreadComments: true }))).toBe("unconfirmed");
  });

  it("未読コメントが無ければconfirmedを返す", () => {
    expect(resolveQuestionState(makeQuestion())).toBe("confirmed");
  });
});

describe("isQaAnswerWaiting", () => {
  // 一覧の行は質問Issueに限らない（#2309）。通常のIssueのコメント欄からも質問を投げられる
  it("質問Issueでなくても回答待ちならtrueを返す", () => {
    expect(
      isQaAnswerWaiting(
        makeQuestion({ title: "通常のIssue", qaAnswerPendingAt: "2026-01-01T00:00:00.000Z" }),
      ),
    ).toBe(true);
  });

  it("回答待ちでなければfalseを返す", () => {
    expect(isQaAnswerWaiting(makeQuestion({ hasUnreadComments: true }))).toBe(false);
  });
});
