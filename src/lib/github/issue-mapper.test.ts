import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mapComment } from "@/lib/github/issue-mapper";

const ORIGINAL_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;

function raw(body: string, login: string) {
  return {
    id: 1,
    user: { login },
    body,
    created_at: "2026-08-11T00:00:00Z",
    reactions: { "+1": 0 },
  };
}

const MARKER = "\n\n<!-- issue-deck:posted-by:m-guchi -->";

beforeEach(() => {
  process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "issue-deck";
});

afterEach(() => {
  if (ORIGINAL_SLUG === undefined) {
    delete process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  } else {
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = ORIGINAL_SLUG;
  }
});

describe("mapComment の投稿者解決", () => {
  it("issue-deckのApp名義のコメントは、投稿者マーカーの人間として表示する", () => {
    // カンバンのStatus変更で起動したコメント。ボタン経由と同じ見た目にするため人間へ寄せる
    const comment = mapComment(raw(`@claude 実装を開始してください${MARKER}`, "issue-deck[bot]"));

    expect(comment.author.login).toBe("m-guchi");
  });

  it("マーカーは本文から取り除く", () => {
    const comment = mapComment(raw(`@claude 実装を開始してください${MARKER}`, "issue-deck[bot]"));

    expect(comment.body).toBe("@claude 実装を開始してください");
    expect(comment.body).not.toContain("posted-by");
  });

  it("issue-deck以外の投稿者のマーカーは信用しない（なりすまし防止）", () => {
    // パブリックリポジトリでは誰でも本文末尾に偽のマーカーを付けられる
    const comment = mapComment(raw(`本文${MARKER}`, "attacker"));

    expect(comment.author.login).toBe("attacker");
  });

  it("他のBotが付けたマーカーも信用しない", () => {
    const comment = mapComment(raw(`本文${MARKER}`, "github-actions[bot]"));

    expect(comment.author.login).toBe("github-actions[bot]");
  });

  it("マーカーが無いApp名義のコメントはApp名義のまま表示する", () => {
    const comment = mapComment(raw("🔧 依頼を確認しました。", "issue-deck[bot]"));

    expect(comment.author.login).toBe("issue-deck[bot]");
  });

  it("末尾以外にあるマーカーは効かない（ユーザー入力より後ろに付く前提のため）", () => {
    const comment = mapComment(
      raw(`${MARKER.trim()}\n\n本文が続く`, "issue-deck[bot]"),
    );

    expect(comment.author.login).toBe("issue-deck[bot]");
  });

  it("投稿者が取得できない場合はunknownにする", () => {
    const comment = mapComment({
      id: 1,
      user: undefined,
      body: "本文",
      created_at: "2026-08-11T00:00:00Z",
      reactions: { "+1": 0 },
    } as unknown as Parameters<typeof mapComment>[0]);

    expect(comment.author.login).toBe("unknown");
  });
});
