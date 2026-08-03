import { describe, expect, it } from "vitest";

import {
  ASK_CLAUDE_COMMENT_PREFIX,
  askClaudeCommentBody,
  canAskClaude,
  isAskClaudeQuestionComment,
  isQaAnswerComment,
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
