import { describe, expect, it } from "vitest";

import { buildClaudeAppPrompt, buildClaudeAppUrl } from "@/lib/github/claude-app";

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
  it("branch=developとプロンプトをクエリパラメータに含むURLを組み立てる", () => {
    const url = new URL(buildClaudeAppUrl(issue));
    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/code/new");
    expect(url.searchParams.get("branch")).toBe("develop");
    expect(url.searchParams.get("q")).toBe(buildClaudeAppPrompt(issue));
  });
});
