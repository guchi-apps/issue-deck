import { describe, expect, it } from "vitest";

import {
  countUnconfirmedQuestions,
  countWaitingQuestions,
  formatQuestionListCount,
  formatQuestionNavTitle,
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

describe("countWaitingQuestions", () => {
  // 押した先（「質問」ビュー）に並ぶのは質問Issueだけなので、通常のIssueは数えない（#2309）
  it("回答待ちの質問Issueだけを数える", () => {
    expect(
      countWaitingQuestions([
        makeQuestion({ qaAnswerPendingAt: "2026-01-01T00:00:00.000Z" }),
        makeQuestion({ hasUnreadComments: true }),
        makeQuestion(),
        makeQuestion({ title: "通常のIssue", qaAnswerPendingAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ).toBe(1);
  });

  it("1件も無ければ0を返す", () => {
    expect(countWaitingQuestions([])).toBe(0);
  });
});

describe("formatQuestionNavTitle", () => {
  // 数字（一覧に並ぶ件数）と丸（未確認）で意味が違うため、行のラベルだけでは読めない（#2070）
  it("未確認があれば内訳を添える", () => {
    expect(formatQuestionNavTitle(3, 1)).toBe(
      "開いている質問が3件（うち回答が届いていてまだ開いていないものが1件）あります",
    );
  });

  it("未確認が無ければ総数だけを出す", () => {
    expect(formatQuestionNavTitle(3, 0)).toBe("開いている質問が3件あります");
  });

  // スピナーだけでは何件待っているのか読めない（#2309）
  it("回答待ちがあれば内訳の先頭に添える", () => {
    expect(formatQuestionNavTitle(3, 0, 2)).toBe(
      "開いている質問が3件（うち回答待ちが2件）あります",
    );
  });

  it("回答待ちと未確認が両方あれば回答待ちを先に並べる", () => {
    expect(formatQuestionNavTitle(3, 2, 1)).toBe(
      "開いている質問が3件（うち回答待ちが1件・回答が届いていてまだ開いていないものが2件）あります",
    );
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
