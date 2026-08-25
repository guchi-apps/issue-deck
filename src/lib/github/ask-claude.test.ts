import { describe, expect, it } from "vitest";

import {
  ASK_CLAUDE_COMMENT_PREFIX,
  ASK_REPO_QUESTION_TITLE_PREFIX,
  ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY,
  askClaudeCommentBody,
  buildAskRepoQuestionTitle,
  canAskClaude,
  canCloseAskRepoQuestion,
  CROSS_REPO_QUESTION_MARKER,
  crossRepoQuestionCommentBody,
  isAskClaudeQuestionComment,
  isAskRepoQuestionIssue,
  isCrossRepoQuestionComment,
  isQaAnswerComment,
  isQaAnswerPending,
  QA_ANSWER_MARKER,
  resolveComposerPrimaryAction,
  resolveCrossRepoQuestionRepository,
  QUESTION_COMMENT_MARKER,
} from "@/lib/github/ask-claude";
import { FALLBACK_NOTICE_MARKER } from "@/lib/github/fallback-notice";

describe("askClaudeCommentBody", () => {
  it("質問文の前後の空白を除去し、プレフィックスとマーカーを付与する", () => {
    expect(askClaudeCommentBody("  これは質問です  ")).toBe(
      `${ASK_CLAUDE_COMMENT_PREFIX}これは質問です\n\n${QUESTION_COMMENT_MARKER}`,
    );
  });

  it("trigger: none ではActionsのトリガー（@claude）を含めず、マーカーだけを付与する", () => {
    const body = askClaudeCommentBody("これは質問です", { trigger: "none" });
    expect(body).toBe(`これは質問です\n\n${QUESTION_COMMENT_MARKER}`);
    // Actionsのトリガー条件は本文が`@claude`で始まることなので、含まないことが要（#1294）
    expect(body.includes("@claude")).toBe(false);
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
  it("マーカー付きのコメントをtrueと判定する", () => {
    expect(isAskClaudeQuestionComment({ body: askClaudeCommentBody("質問内容") })).toBe(true);
  });

  it("Actionsを起こさない形（@claudeを含まない）でもtrueと判定する", () => {
    expect(
      isAskClaudeQuestionComment({ body: askClaudeCommentBody("質問内容", { trigger: "none" }) }),
    ).toBe(true);
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

/**
 * #1454。横断質問は**サブPCの質問セッションが答える**ため、GitHub Actionsを起こさない形の
 * 本文（`trigger: "none"`）に横断のマーカーを足す。
 */
describe("複数リポジトリ横断の質問（#1454）", () => {
  it("Actionsのトリガーを含まず、質問と横断のマーカーを持つ", () => {
    const body = crossRepoQuestionCommentBody("issue-deckとops-dashboardの違いは？");
    expect(body.startsWith("@claude")).toBe(false);
    expect(body).toContain(QUESTION_COMMENT_MARKER);
    expect(body).toContain(CROSS_REPO_QUESTION_MARKER);
    // 質問コメントとしては従来どおり認識される（回答待ちの表示・ワンボタンクローズが効く）
    expect(isAskClaudeQuestionComment({ body })).toBe(true);
    expect(isCrossRepoQuestionComment({ body })).toBe(true);
  });

  it("単一リポジトリの質問は横断とは判定しない", () => {
    expect(isCrossRepoQuestionComment({ body: askClaudeCommentBody("これは？") })).toBe(false);
  });

  it("記録先の既定は名前が question のリポジトリ", () => {
    expect(
      resolveCrossRepoQuestionRepository(
        ["guchi-apps/issue-deck", "guchi-apps/question", "guchi-apps/dayspan"],
        "guchi-apps/issue-deck",
      ),
    ).toBe("guchi-apps/question");
  });

  // まだ作っていない段階でも機能そのものは動く（記録先が従来の既定になるだけ）
  it("question リポジトリが連携されていなければフォールバックする", () => {
    expect(
      resolveCrossRepoQuestionRepository(["guchi-apps/issue-deck"], "guchi-apps/issue-deck"),
    ).toBe("guchi-apps/issue-deck");
    expect(resolveCrossRepoQuestionRepository([], null)).toBeNull();
  });
});

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
    expect(buildAskRepoQuestionTitle("1行目\n\n2行目   3行目")).toBe("[質問] 1行目 2行目 3行目");
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

/**
 * コメント欄の下の操作列の主ボタン（#2345）。**入力欄が空かどうかで付け替える**ので、
 * 同じIssue・同じコメント列でも下書きの有無で答えが変わる。
 */
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

  it("質問Issueで回答済みでも、入力があれば質問が主", () => {
    expect(resolveComposerPrimaryAction(askIssue, answered, true)).toBe("question");
  });

  it("質問Issueで回答待ちなら、入力の有無によらず質問が主", () => {
    expect(resolveComposerPrimaryAction(askIssue, pending, false)).toBe("question");
    expect(resolveComposerPrimaryAction(askIssue, pending, true)).toBe("question");
  });

  it("質問Issueでなければ、入力の有無によらずコメントが主", () => {
    const normal = { state: "open" as const, title: "ログイン画面のレイアウトを見直す" };
    expect(resolveComposerPrimaryAction(normal, [], false)).toBe("comment");
    expect(resolveComposerPrimaryAction(normal, answered, true)).toBe("comment");
  });

  it("closedな質問Issueではコメントが主（「質問する」ボタンが出ないため）", () => {
    expect(resolveComposerPrimaryAction({ ...askIssue, state: "closed" }, answered, true)).toBe(
      "comment",
    );
  });
});
