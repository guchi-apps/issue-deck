import { describe, expect, it } from "vitest";

import { SESSION_PLAN_WAIT_SECONDS_DEFAULT } from "@/lib/dispatch/session-plan-request";
import {
  SESSION_QUESTION_FREE_TEXT_MAX_LENGTH,
  SESSION_QUESTION_PREVIEW_LIMIT,
  SESSION_QUESTION_WAIT_SECONDS_DEFAULT,
  SESSION_QUESTION_WAIT_SECONDS_MAX,
  SESSION_QUESTION_WAIT_SECONDS_MIN,
  buildSessionQuestionAnswerCommentBody,
  buildSessionQuestionAnswers,
  findQuestionRequestForIssue,
  parseSessionQuestionWaitSeconds,
  parseSessionQuestions,
  type SessionQuestion,
  type SessionQuestionRequestView,
} from "@/lib/dispatch/session-question-request";

/**
 * 質問への回答（#2189）の純粋な部分。
 *
 * ここが守っているのは**「画面から送った文字列がそのままClaude Codeのツール入力になる」**
 * という一点で、質問に無い選択肢を通すと`updatedInput`のスキーマ検証で回答ごと弾かれ、
 * セッションは端末の選択フォームの前で止まったままになる。
 */

const QUESTIONS: SessionQuestion[] = [
  {
    question: "認証方式はどれにしますか？",
    header: "認証",
    options: [
      { label: "Supabase Auth", description: "既存アプリと同じ" },
      { label: "NextAuth", description: "自由度が高い" },
    ],
    multiSelect: false,
  },
  {
    question: "どの画面に入れますか？",
    header: "対象画面",
    options: [
      { label: "PC", description: "Issue詳細" },
      { label: "スマホ", description: "Issue詳細" },
    ],
    multiSelect: true,
  },
];

describe("parseSessionQuestions", () => {
  it("選択肢つきの質問をそのまま通す", () => {
    const parsed = parseSessionQuestions([
      {
        question: "どれにしますか？",
        header: "方式",
        options: [
          { label: "A", description: "説明A" },
          { label: "B", description: "説明B" },
        ],
        multiSelect: true,
      },
    ]);

    expect(parsed).toEqual([
      {
        question: "どれにしますか？",
        header: "方式",
        options: [
          { label: "A", description: "説明A" },
          { label: "B", description: "説明B" },
        ],
        multiSelect: true,
      },
    ]);
  });

  // 形が想定と違う質問で全体を落とすと、Claude Code側のスキーマが増えた時点で機能ごと止まる
  it("壊れた質問は落とし、残りだけを返す", () => {
    const parsed = parseSessionQuestions([
      { question: "選択肢が1つ", options: [{ label: "A", description: "" }] },
      null,
      {
        question: "こちらは有効",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
    ]);

    expect(parsed?.map((entry) => entry.question)).toEqual(["こちらは有効"]);
  });

  it("1件も残らなければnull（＝待ちを作らず端末へ倒す）", () => {
    expect(parseSessionQuestions([])).toBeNull();
    expect(parseSessionQuestions("questions")).toBeNull();
    expect(parseSessionQuestions([{ question: "選択肢なし", options: [] }])).toBeNull();
  });

  // 見た目の案を並べて選ばせる使い方があるので、`preview`は落とさずに切り詰める
  it("長すぎるpreviewは切って残す", () => {
    const parsed = parseSessionQuestions([
      {
        question: "どの見た目にしますか？",
        options: [
          { label: "A", description: "", preview: "x".repeat(SESSION_QUESTION_PREVIEW_LIMIT + 50) },
          { label: "B", description: "" },
        ],
      },
    ]);

    expect(parsed?.[0].options[0].preview).toHaveLength(SESSION_QUESTION_PREVIEW_LIMIT);
  });
});

describe("buildSessionQuestionAnswers", () => {
  it("選んだラベルを質問文をキーにした回答へ変える", () => {
    const answers = buildSessionQuestionAnswers(QUESTIONS, [
      { question: "認証方式はどれにしますか？", options: ["Supabase Auth"] },
      { question: "どの画面に入れますか？", options: ["PC", "スマホ"] },
    ]);

    expect(answers).toEqual({
      // 複数選択はカンマ区切りの1本の文字列（Claude Code側の受け取り方）
      "認証方式はどれにしますか？": "Supabase Auth",
      "どの画面に入れますか？": "PC, スマホ",
    });
  });

  it("「その他」の自由記述を選択肢の後ろへ足す", () => {
    const answers = buildSessionQuestionAnswers(QUESTIONS, [
      { question: "認証方式はどれにしますか？", options: [], text: "自前で書く" },
      { question: "どの画面に入れますか？", options: ["PC"], text: "カンバンにも出したい" },
    ]);

    expect(answers).toEqual({
      "認証方式はどれにしますか？": "自前で書く",
      "どの画面に入れますか？": "PC, カンバンにも出したい",
    });
  });

  // **ここが本命。** 質問に無いラベルを通すと`updatedInput`のスキーマ検証で回答ごと弾かれる
  it("質問に無いラベルは通さない", () => {
    expect(
      buildSessionQuestionAnswers(QUESTIONS, [
        { question: "認証方式はどれにしますか？", options: ["Auth0"] },
        { question: "どの画面に入れますか？", options: ["PC"] },
      ]),
    ).toBeNull();
  });

  it("単一選択に2つ選んだものは通さない", () => {
    expect(
      buildSessionQuestionAnswers(QUESTIONS, [
        { question: "認証方式はどれにしますか？", options: ["Supabase Auth", "NextAuth"] },
        { question: "どの画面に入れますか？", options: ["PC"] },
      ]),
    ).toBeNull();
  });

  // 1問でも空だとツールの結果が「(no option selected)」になり、後から読めない
  it("答えていない質問が1つでもあれば通さない", () => {
    expect(
      buildSessionQuestionAnswers(QUESTIONS, [
        { question: "認証方式はどれにしますか？", options: ["NextAuth"] },
        { question: "どの画面に入れますか？", options: [] },
      ]),
    ).toBeNull();
    expect(
      buildSessionQuestionAnswers(QUESTIONS, [
        { question: "認証方式はどれにしますか？", options: ["NextAuth"] },
      ]),
    ).toBeNull();
  });

  it("長すぎる自由記述は通さない", () => {
    expect(
      buildSessionQuestionAnswers(QUESTIONS, [
        {
          question: "認証方式はどれにしますか？",
          options: [],
          text: "あ".repeat(SESSION_QUESTION_FREE_TEXT_MAX_LENGTH + 1),
        },
        { question: "どの画面に入れますか？", options: ["PC"] },
      ]),
    ).toBeNull();
  });
});

describe("parseSessionQuestionWaitSeconds", () => {
  it("範囲外は丸め、壊れた値は既定へ倒す", () => {
    expect(parseSessionQuestionWaitSeconds(10)).toBe(SESSION_QUESTION_WAIT_SECONDS_MIN);
    expect(parseSessionQuestionWaitSeconds(99999)).toBe(SESSION_QUESTION_WAIT_SECONDS_MAX);
    expect(parseSessionQuestionWaitSeconds("なにか")).toBe(SESSION_QUESTION_WAIT_SECONDS_DEFAULT);
  });

  // `0`を下限へ丸めると、フックは待たないのに画面へ押しても届かないパネルが残る
  it("0はそのまま0（＝待たない）", () => {
    expect(parseSessionQuestionWaitSeconds(0)).toBe(0);
  });

  /**
   * #2189の計画レビューG1・指摘1。**待っている間は端末で答える手段が実質的に無い**
   * （`Esc`は待ちを抜けるのではなくturnごと打ち切る）。`ExitPlanMode`は1セッションに1回の
   * 関門だが質問は常用経路なので、既定を計画より短くしてある。ここを揃えると、端末に
   * 座っている人が質問のたびに長く待たされる。
   */
  it("既定は計画の待ち時間より短い", () => {
    expect(SESSION_QUESTION_WAIT_SECONDS_DEFAULT).toBeLessThan(SESSION_PLAN_WAIT_SECONDS_DEFAULT);
  });
});

describe("findQuestionRequestForIssue", () => {
  const base = {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2189,
    hostName: "subpc",
    questions: QUESTIONS,
    answers: null,
    expiresAt: "2026-08-23T10:00:00.000Z",
    delivered: false,
  };
  const now = new Date("2026-08-23T09:30:00.000Z");

  it("待っているものを最優先で返す（決まった直後の行と並んでも）", () => {
    const requests: SessionQuestionRequestView[] = [
      {
        ...base,
        id: "old",
        status: "ANSWERED",
        createdAt: "2026-08-23T09:00:00.000Z",
        decidedAt: "2026-08-23T09:29:00.000Z",
      },
      {
        ...base,
        id: "new",
        status: "WAITING",
        createdAt: "2026-08-23T09:29:30.000Z",
        decidedAt: null,
      },
    ];

    expect(findQuestionRequestForIssue(requests, base.repositoryFullName, 2189, now)?.id).toBe(
      "new",
    );
  });

  it("決まってから時間が経った行は返さない", () => {
    const requests: SessionQuestionRequestView[] = [
      {
        ...base,
        id: "old",
        status: "ANSWERED",
        createdAt: "2026-08-23T09:00:00.000Z",
        decidedAt: "2026-08-23T09:00:10.000Z",
      },
    ];

    expect(findQuestionRequestForIssue(requests, base.repositoryFullName, 2189, now)).toBeNull();
  });
});

describe("buildSessionQuestionAnswerCommentBody", () => {
  it("質問と回答を1件のコメントにまとめる", () => {
    const body = buildSessionQuestionAnswerCommentBody({
      decision: "answer",
      questions: QUESTIONS,
      answers: {
        "認証方式はどれにしますか？": "Supabase Auth",
        "どの画面に入れますか？": "PC, スマホ",
      },
      posterMarker: "<!-- issue-deck:posted-by:m-guchi -->",
    });

    expect(body).toContain("認証方式はどれにしますか？");
    expect(body).toContain("Supabase Auth");
    expect(body).toContain("PC, スマホ");
    expect(body.trimEnd().endsWith("<!-- issue-deck:posted-by:m-guchi -->")).toBe(true);
  });

  it("端末で答えることにしたときは、回答を並べない", () => {
    const body = buildSessionQuestionAnswerCommentBody({
      decision: "defer",
      questions: QUESTIONS,
      answers: null,
      posterMarker: "<!-- issue-deck:posted-by:m-guchi -->",
    });

    expect(body).toContain("端末で答える");
    expect(body).not.toContain("Supabase Auth");
  });
});
