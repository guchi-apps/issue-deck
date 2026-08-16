import { describe, expect, it } from "vitest";

import {
  countUnconfirmedQuestions,
  formatQuestionListCount,
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

describe("countUnconfirmedQuestions", () => {
  it("未確認の質問だけを数える", () => {
    expect(
      countUnconfirmedQuestions([
        makeQuestion({ hasUnreadComments: true }),
        makeQuestion({ hasUnreadComments: true }),
        makeQuestion(),
        makeQuestion({ qaAnswerPendingAt: "2026-01-01T00:00:00.000Z", hasUnreadComments: true }),
        makeQuestion({ title: "通常のIssue", hasUnreadComments: true }),
      ]),
    ).toBe(2);
  });

  it("1件も無ければ0を返す", () => {
    expect(countUnconfirmedQuestions([])).toBe(0);
  });
});

describe("formatQuestionListCount", () => {
  it("未確認があれば内訳を添える", () => {
    expect(
      formatQuestionListCount(
        [makeQuestion({ hasUnreadComments: true }), makeQuestion(), makeQuestion()],
        3,
      ),
    ).toBe("3件・未確認1件");
  });

  it("未確認が無ければnullを返す（呼び出し側が従来の表記に落とす）", () => {
    expect(formatQuestionListCount([makeQuestion(), makeQuestion()], 2)).toBeNull();
  });
});
