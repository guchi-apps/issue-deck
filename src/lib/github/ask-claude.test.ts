import { describe, expect, it } from "vitest";

import {
  ASK_CLAUDE_COMMENT_PREFIX,
  ASK_REPO_QUESTION_TITLE_PREFIX,
  ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY,
  canCloseAskRepoQuestion,
  CROSS_REPO_QUESTION_MARKER,
  isAskClaudeQuestionComment,
  isAskRepoQuestionIssue,
  isCrossRepoQuestionComment,
  isCrossRepoQuestionIssue,
  isQaAnswerComment,
  isQaAnswerPending,
  QA_ANSWER_MARKER,
  resolveComposerPrimaryAction,
  QUESTION_COMMENT_MARKER,
} from "@/lib/github/ask-claude";
import { FALLBACK_NOTICE_MARKER } from "@/lib/github/fallback-notice";

// 質問の投稿は#5047で廃止したので、過去に積まれた質問コメントの形をここで組み立てる
const askClaudeCommentBody = (question: string) => `${question.trim()}\n\n${QUESTION_COMMENT_MARKER}`;
const crossRepoQuestionCommentBody = (question: string) =>
  `${askClaudeCommentBody(question)}\n${CROSS_REPO_QUESTION_MARKER}`;

describe("isAskClaudeQuestionComment", () => {
  it("マーカー付きのコメントをtrueと判定する", () => {
    expect(isAskClaudeQuestionComment({ body: askClaudeCommentBody("質問内容") })).toBe(true);
  });

  it("マーカーが無い旧形式（@claude 質問: ）もtrueと判定する", () => {
    // 既にIssueへ積まれている質問コメントは移行できないため、旧形式も質問として扱う（#1294）
    expect(isAskClaudeQuestionComment({ body: `${ASK_CLAUDE_COMMENT_PREFIX}質問内容` })).toBe(true);
  });

  it("それ以外のコメントはfalseと判定する", () => {
    expect(isAskClaudeQuestionComment({ body: "@claude 実装をお願いします" })).toBe(false);
  });
});

describe("isQaAnswerComment", () => {
  it("マーカー付きのコメントをtrueと判定する", () => {
    expect(isQaAnswerComment({ body: `回答本文\n\n${QA_ANSWER_MARKER}` })).toBe(true);
  });

  it("マーカーが無いコメントはfalseと判定する", () => {
    expect(isQaAnswerComment({ body: "通常の実装進捗コメント" })).toBe(false);
  });
});

describe("isQaAnswerPending", () => {
  it("コメントが1件も無い場合はfalseを返す", () => {
    expect(isQaAnswerPending([])).toBe(false);
  });

  it("質問コメントの後に回答コメントが無い場合はtrueを返す", () => {
    const comments = [
      { body: "通常の実装進捗コメント" },
      { body: askClaudeCommentBody("質問内容") },
    ];
    expect(isQaAnswerPending(comments)).toBe(true);
  });

  it("質問コメントの後に回答コメントが投稿済みの場合はfalseを返す", () => {
    const comments = [
      { body: askClaudeCommentBody("質問内容") },
      { body: `回答本文\n\n${QA_ANSWER_MARKER}` },
    ];
    expect(isQaAnswerPending(comments)).toBe(false);
  });

  it("回答済みの質問の後に新たな質問が投稿された場合はtrueを返す", () => {
    const comments = [
      { body: askClaudeCommentBody("質問1") },
      { body: `回答本文\n\n${QA_ANSWER_MARKER}` },
      { body: askClaudeCommentBody("質問2") },
    ];
    expect(isQaAnswerPending(comments)).toBe(true);
  });

  it("質問コメントが無い場合はfalseを返す", () => {
    const comments = [{ body: "通常の実装進捗コメント" }];
    expect(isQaAnswerPending(comments)).toBe(false);
  });

  it("質問コメントの後に回答できなかった通知が投稿された場合はfalseを返す（#1766）", () => {
    const comments = [
      { body: askClaudeCommentBody("質問内容") },
      { body: `⚠️ 質問への回答を投稿できませんでした。\n\n${FALLBACK_NOTICE_MARKER}` },
    ];
    expect(isQaAnswerPending(comments)).toBe(false);
  });

  it("回答できなかった通知の後に質問し直した場合はtrueを返す（#1766）", () => {
    const comments = [
      { body: askClaudeCommentBody("質問1") },
      { body: `⚠️ 質問への回答を投稿できませんでした。\n\n${FALLBACK_NOTICE_MARKER}` },
      { body: askClaudeCommentBody("質問2") },
    ];
    expect(isQaAnswerPending(comments)).toBe(true);
  });
});

describe("isAskRepoQuestionIssue", () => {
  it("質問接頭辞で始まるタイトルをtrueと判定する", () => {
    expect(isAskRepoQuestionIssue({ title: `${ASK_REPO_QUESTION_TITLE_PREFIX}質問内容` })).toBe(
      true,
    );
  });

  it("接頭辞は`[質問] `になっている（#1514）", () => {
    expect(ASK_REPO_QUESTION_TITLE_PREFIX).toBe("[質問] ");
  });

  it("旧接頭辞（`質問: `）で作られた既存Issueもtrueと判定する（#1514）", () => {
    expect(
      isAskRepoQuestionIssue({ title: `${ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY}質問内容` }),
    ).toBe(true);
  });

  it("それ以外のタイトルはfalseと判定する", () => {
    expect(isAskRepoQuestionIssue({ title: "通常のIssueタイトル" })).toBe(false);
  });

  it("接頭辞がタイトルの途中に現れるだけの場合はfalseと判定する", () => {
    expect(isAskRepoQuestionIssue({ title: "設計の質問: をどう扱うか" })).toBe(false);
  });
});

describe("canCloseAskRepoQuestion", () => {
  const askIssue = { state: "open" as const, title: `${ASK_REPO_QUESTION_TITLE_PREFIX}質問内容` };

  it("open・質問Issue・回答待ちでない場合はtrueを返す", () => {
    const comments = [
      { body: askClaudeCommentBody("質問内容") },
      { body: `回答本文\n\n${QA_ANSWER_MARKER}` },
    ];
    expect(canCloseAskRepoQuestion(askIssue, comments)).toBe(true);
  });

  it("closedな場合はfalseを返す", () => {
    expect(canCloseAskRepoQuestion({ ...askIssue, state: "closed" }, [])).toBe(false);
  });

  it("質問Issueでない場合はfalseを返す", () => {
    expect(canCloseAskRepoQuestion({ state: "open", title: "通常のIssue" }, [])).toBe(false);
  });

  it("回答待ちの場合はfalseを返す", () => {
    const comments = [{ body: askClaudeCommentBody("質問内容") }];
    expect(canCloseAskRepoQuestion(askIssue, comments)).toBe(false);
  });
});

describe("resolveComposerPrimaryAction", () => {
  const askIssue = { state: "open" as const, title: `${ASK_REPO_QUESTION_TITLE_PREFIX}質問内容` };
  const answered = [
    { body: askClaudeCommentBody("質問内容") },
    { body: `回答本文\n\n${QA_ANSWER_MARKER}` },
  ];
  const pending = [{ body: askClaudeCommentBody("質問内容") }];

  it("質問Issueで回答済み・入力が空なら、クローズが主", () => {
    expect(resolveComposerPrimaryAction(askIssue, answered, false)).toBe("close");
  });

  it("質問Issueで回答済みでも、入力があればコメントが主（質問の送信は#5047で廃止）", () => {
    expect(resolveComposerPrimaryAction(askIssue, answered, true)).toBe("comment");
  });

  it("質問Issueで回答待ちならコメントが主", () => {
    expect(resolveComposerPrimaryAction(askIssue, pending, false)).toBe("comment");
  });

  it("質問Issueでなければコメントが主", () => {
    expect(resolveComposerPrimaryAction({ state: "open", title: "通常のIssue" }, answered, false)).toBe(
      "comment",
    );
  });

  it("closedな質問Issueではコメントが主", () => {
    expect(resolveComposerPrimaryAction({ ...askIssue, state: "closed" }, answered, false)).toBe(
      "comment",
    );
  });
});

describe("isCrossRepoQuestionIssue", () => {
  it("横断質問のコメントが1件でもあればtrue", () => {
    expect(isCrossRepoQuestionIssue([{ body: crossRepoQuestionCommentBody("横断の質問") }])).toBe(
      true,
    );
    expect(isCrossRepoQuestionComment({ body: crossRepoQuestionCommentBody("横断の質問") })).toBe(true);
  });

  it("ふつうの質問コメントだけならfalse", () => {
    expect(isCrossRepoQuestionIssue([{ body: askClaudeCommentBody("質問内容") }])).toBe(false);
  });
});
