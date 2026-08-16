import { describe, expect, it } from "vitest";

import { buildImplementationPrompt } from "@/lib/prompts/build-implementation-prompt";

function build(relations?: Parameters<typeof buildImplementationPrompt>[0]["relations"]) {
  return buildImplementationPrompt({
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1722,
    title: "サブIssueの表示を直す",
    body: "本文",
    labels: [{ name: "50.feature" }],
    comments: [],
    relations,
  });
}

describe("buildImplementationPrompt の親子Issue", () => {
  it("同じリポジトリの親子は番号だけで書く", () => {
    const prompt = build([
      { number: 1698, title: "親", state: "open", relation: "parent" },
      {
        number: 1740,
        title: "子",
        state: "open",
        relation: "sub",
        repositoryFullName: "guchi-apps/issue-deck",
      },
    ]);

    expect(prompt).toContain("- 親: #1698 親（open）");
    expect(prompt).toContain("- 子: #1740 子（open）");
  });

  it("別リポジトリの親子は owner/repo#番号 で書く（#1722）", () => {
    // `#12`とだけ書くと、受け取ったエージェントの側では自分のリポジトリのIssueに解決してしまう
    const prompt = build([
      {
        number: 12,
        title: "car-careへの横展開",
        state: "open",
        relation: "sub",
        repositoryFullName: "guchi-apps/car-care",
      },
    ]);

    expect(prompt).toContain("- 子: guchi-apps/car-care#12 car-careへの横展開（open）");
  });

  it("親子を取っていない経路と、親子が無い場合を書き分ける", () => {
    expect(build(undefined)).toContain("（この経路では取得していません）");
    expect(build([])).toContain("(親子関係のあるIssueはありません)");
  });
});
