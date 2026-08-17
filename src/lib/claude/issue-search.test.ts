import { describe, expect, it } from "vitest";

import {
  ISSUE_SEARCH_RESULT_LIMIT,
  buildIssueSearchPrompt,
  pickMatchedIssueKeys,
} from "@/lib/claude/issue-search";

const candidates = [
  { key: "owner/repo#1", title: "一覧の絞り込みが重い", labels: ["50.feature"] },
  { key: "owner/repo#2", title: "ログインできない", labels: [] },
];

describe("buildIssueSearchPrompt", () => {
  it("検索語と候補のキー・タイトル・ラベルを含める", () => {
    const prompt = buildIssueSearchPrompt({ query: "検索が遅い", candidates });

    expect(prompt).toContain("検索が遅い");
    expect(prompt).toContain("- owner/repo#1 一覧の絞り込みが重い [50.feature]");
    expect(prompt).toContain("- owner/repo#2 ログインできない");
  });

  it("本文は渡さない前提のため、候補にはタイトル以外の長文が入らない", () => {
    const prompt = buildIssueSearchPrompt({
      query: "検索",
      candidates: [{ key: "owner/repo#1", title: "タイトル", labels: [] }],
    });

    expect(prompt).not.toContain("本文");
  });
});

describe("pickMatchedIssueKeys", () => {
  const keys = candidates.map((candidate) => candidate.key);

  it("候補に実在するキーを応答の順序で返す", () => {
    const text = '{"issues": ["owner/repo#2", "owner/repo#1"]}';

    expect(pickMatchedIssueKeys(text, keys)).toEqual(["owner/repo#2", "owner/repo#1"]);
  });

  it("コードフェンス付きの応答も読む", () => {
    const text = '```json\n{"issues": ["owner/repo#1"]}\n```';

    expect(pickMatchedIssueKeys(text, keys)).toEqual(["owner/repo#1"]);
  });

  it("候補に無いキーは捨てる", () => {
    const text = '{"issues": ["owner/repo#999", "other/repo#1", "owner/repo#1"]}';

    expect(pickMatchedIssueKeys(text, keys)).toEqual(["owner/repo#1"]);
  });

  it("同じキーが重複していても1件として扱う", () => {
    const text = '{"issues": ["owner/repo#1", "owner/repo#1"]}';

    expect(pickMatchedIssueKeys(text, keys)).toEqual(["owner/repo#1"]);
  });

  it("JSONとして読めない応答は空配列にする", () => {
    expect(pickMatchedIssueKeys("該当するIssueはありません", keys)).toEqual([]);
    expect(pickMatchedIssueKeys('{"issues": ', keys)).toEqual([]);
  });

  it("issuesが配列でない応答は空配列にする", () => {
    expect(pickMatchedIssueKeys('{"issues": "owner/repo#1"}', keys)).toEqual([]);
  });

  it("上限件数を超えた分は切り捨てる", () => {
    const manyKeys = Array.from({ length: ISSUE_SEARCH_RESULT_LIMIT + 5 }, (_, i) => `owner/repo#${i + 1}`);
    const text = JSON.stringify({ issues: manyKeys });

    expect(pickMatchedIssueKeys(text, manyKeys)).toHaveLength(ISSUE_SEARCH_RESULT_LIMIT);
  });
});
