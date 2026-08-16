import { describe, expect, it } from "vitest";

import {
  buildRepositorySuggestPrompt,
  pickSuggestedRepository,
  RECENT_TITLE_LIMIT,
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

describe("pickSuggestedRepository", () => {
  const candidates = ["guchi-apps/issue-deck", "guchi-apps/car-care"];

  it("候補に存在するフルネームを返す", () => {
    expect(pickSuggestedRepository('{"repository": "guchi-apps/car-care"}', candidates)).toBe(
      "guchi-apps/car-care",
    );
  });

  it("コードフェンスで囲まれていても解釈する", () => {
    expect(
      pickSuggestedRepository('```json\n{"repository": "guchi-apps/issue-deck"}\n```', candidates),
    ).toBe("guchi-apps/issue-deck");
  });

  it("大文字小文字の違いは候補側の表記へ寄せる", () => {
    expect(pickSuggestedRepository('{"repository": "Guchi-Apps/Issue-Deck"}', candidates)).toBe(
      "guchi-apps/issue-deck",
    );
  });

  it("候補に無いフルネームは採らない", () => {
    expect(pickSuggestedRepository('{"repository": "guchi-apps/unknown"}', candidates)).toBeNull();
  });

  it("nullやJSONとして壊れた応答はnullを返す", () => {
    expect(pickSuggestedRepository('{"repository": null}', candidates)).toBeNull();
    expect(pickSuggestedRepository("選べませんでした", candidates)).toBeNull();
  });
});
