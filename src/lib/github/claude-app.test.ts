import { describe, expect, it } from "vitest";

import {
  buildClaudeAppHandoffCommentBody,
  buildClaudeAppPrompt,
  buildClaudeAppUrl,
  CLAUDE_APP_HANDOFF_COMMENT_MARKER,
  isClaudeAppHandoffComment,
} from "@/lib/github/claude-app";

const issue = {
  repositoryFullName: "owner/repo",
  number: 360,
  title: "Claudeアプリの画面が開くボタンを追加",
  htmlUrl: "https://github.com/owner/repo/issues/360",
};

describe("buildClaudeAppPrompt", () => {
  it("リポジトリ名・Issue番号・タイトル・URLを含むプロンプトを組み立てる", () => {
    const prompt = buildClaudeAppPrompt(issue);
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("#360");
    expect(prompt).toContain("Claudeアプリの画面が開くボタンを追加");
    expect(prompt).toContain("https://github.com/owner/repo/issues/360");
  });
});

describe("buildClaudeAppUrl", () => {
  it("Issue固有ブランチ（issue-<番号>）とプロンプトをクエリパラメータに含むURLを組み立てる", () => {
    const url = new URL(buildClaudeAppUrl(issue));
    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/code/new");
    expect(url.searchParams.get("branch")).toBe("issue-360");
    expect(url.searchParams.get("q")).toBe(buildClaudeAppPrompt(issue));
  });

  it("スペースを+ではなく%20でエンコードする（Claudeアプリ側で+がそのまま表示されるため）", () => {
    const url = buildClaudeAppUrl(issue);
    expect(url).not.toContain("+");
    expect(url).toContain("%20");
  });
});

describe("buildClaudeAppHandoffCommentBody", () => {
  it("マーカーを含む引き継ぎ記録コメントを組み立てる", () => {
    const body = buildClaudeAppHandoffCommentBody();
    expect(body).toContain(CLAUDE_APP_HANDOFF_COMMENT_MARKER);
  });

  it("@claudeから書き始めない（claude-issue-dispatch.ymlのトリガーを誤爆させないため）", () => {
    const body = buildClaudeAppHandoffCommentBody();
    expect(body.startsWith("@claude")).toBe(false);
  });
});

describe("isClaudeAppHandoffComment", () => {
  it("マーカーを含むコメントを引き継ぎ記録コメントと判定する", () => {
    expect(isClaudeAppHandoffComment({ body: buildClaudeAppHandoffCommentBody() })).toBe(true);
  });

  it("マーカーを含まないコメントは引き継ぎ記録コメントと判定しない", () => {
    expect(isClaudeAppHandoffComment({ body: "普通のコメントです" })).toBe(false);
  });
});
