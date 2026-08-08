import { describe, expect, it } from "vitest";

import {
  ASK_CLAUDE_COMMENT_PREFIX,
  askClaudeCommentBody,
  canAskClaude,
  isAskClaudeQuestionComment,
  isQaAnswerComment,
  isQaAnswerPending,
  QA_ANSWER_MARKER,
} from "@/lib/github/ask-claude";

describe("askClaudeCommentBody", () => {
  it("質問文の前後の空白を除去し、プレフィックスを付与する", () => {
    expect(askClaudeCommentBody("  これは質問です  ")).toBe(
      `${ASK_CLAUDE_COMMENT_PREFIX}これは質問です`,
    );
  });
});

describe("canAskClaude", () => {
  it("openなissueではtrueを返す", () => {
    expect(canAskClaude({ state: "open" })).toBe(true);
  });

  it("closedなissueではfalseを返す", () => {
    expect(canAskClaude({ state: "closed" })).toBe(false);
  });
});

describe("isAskClaudeQuestionComment", () => {
  it("@claude 質問: で始まるコメントをtrueと判定する", () => {
    expect(isAskClaudeQuestionComment({ body: askClaudeCommentBody("質問内容") })).toBe(true);
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
});
