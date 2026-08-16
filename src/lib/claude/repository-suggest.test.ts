import { describe, expect, it } from "vitest";

import {
  buildRepositorySuggestPrompt,
  pickSuggestedRepositories,
  RECENT_TITLE_LIMIT,
  REPOSITORY_SUGGEST_LIMIT,
} from "@/lib/claude/repository-suggest";

describe("buildRepositorySuggestPrompt", () => {
  it("本文と候補リポジトリ（直近のIssueタイトル付き）を含むプロンプトを組み立てる", () => {
    const prompt = buildRepositorySuggestPrompt({
      body: "PWAで画面を引っ張っても更新されない",
      candidates: [
        {
          fullName: "guchi-apps/issue-deck",
          recentIssueTitles: ["スマホのホーム画面に画面更新ボタンを置く"],
        },
        { fullName: "guchi-apps/car-care", recentIssueTitles: [] },
      ],
    });

    expect(prompt).toContain("PWAで画面を引っ張っても更新されない");
    expect(prompt).toContain("- guchi-apps/issue-deck");
    expect(prompt).toContain("    - スマホのホーム画面に画面更新ボタンを置く");
    expect(prompt).toContain("- guchi-apps/car-care");
  });

  it("直近のIssueタイトルは上限件数までしか渡さない", () => {
    const titles = Array.from({ length: RECENT_TITLE_LIMIT + 3 }, (_, i) => `タイトル${i}`);
    const prompt = buildRepositorySuggestPrompt({
      body: "本文",
      candidates: [{ fullName: "owner/repo", recentIssueTitles: titles }],
    });

    expect(prompt).toContain(`タイトル${RECENT_TITLE_LIMIT - 1}`);
    expect(prompt).not.toContain(`タイトル${RECENT_TITLE_LIMIT}`);
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildRepositorySuggestPrompt({
      body: longBody,
      candidates: [{ fullName: "owner/repo", recentIssueTitles: [] }],
    });

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length);
  });
});

describe("pickSuggestedRepositories", () => {
  const candidates = ["guchi-apps/issue-deck", "guchi-apps/car-care", "guchi-apps/shopping-list"];

  it("候補に存在するフルネームを、返ってきた順（確からしい順）で返す", () => {
    expect(
      pickSuggestedRepositories(
        '{"repositories": ["guchi-apps/car-care", "guchi-apps/issue-deck"]}',
        candidates,
      ),
    ).toEqual(["guchi-apps/car-care", "guchi-apps/issue-deck"]);
  });

  it("コードフェンスで囲まれていても解釈する", () => {
    expect(
      pickSuggestedRepositories(
        '```json\n{"repositories": ["guchi-apps/issue-deck"]}\n```',
        candidates,
      ),
    ).toEqual(["guchi-apps/issue-deck"]);
  });

  it("大文字小文字の違いは候補側の表記へ寄せる", () => {
    expect(
      pickSuggestedRepositories('{"repositories": ["Guchi-Apps/Issue-Deck"]}', candidates),
    ).toEqual(["guchi-apps/issue-deck"]);
  });

  it("候補に無いフルネームは採らない", () => {
    expect(
      pickSuggestedRepositories(
        '{"repositories": ["guchi-apps/unknown", "guchi-apps/car-care"]}',
        candidates,
      ),
    ).toEqual(["guchi-apps/car-care"]);
  });

  it("重複と上限を整理する", () => {
    expect(
      pickSuggestedRepositories(
        '{"repositories": ["guchi-apps/car-care", "guchi-apps/car-care", "guchi-apps/issue-deck", "guchi-apps/shopping-list", "guchi-apps/issue-deck"]}',
        candidates,
      ),
    ).toEqual([
      "guchi-apps/car-care",
      "guchi-apps/issue-deck",
      "guchi-apps/shopping-list",
    ]);
    expect(REPOSITORY_SUGGEST_LIMIT).toBe(3);
  });

  it("1件だけを返す旧来の形式（repository）も受け取る", () => {
    expect(pickSuggestedRepositories('{"repository": "guchi-apps/car-care"}', candidates)).toEqual([
      "guchi-apps/car-care",
    ]);
  });

  it("空配列やJSONとして壊れた応答は空配列を返す", () => {
    expect(pickSuggestedRepositories('{"repositories": []}', candidates)).toEqual([]);
    expect(pickSuggestedRepositories('{"repository": null}', candidates)).toEqual([]);
    expect(pickSuggestedRepositories("選べませんでした", candidates)).toEqual([]);
  });
});
