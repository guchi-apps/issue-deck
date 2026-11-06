import { describe, expect, it } from "vitest";

import {
  isInReleaseHistoryScope,
  mergeReleaseHistoryByRepository,
  parseReleaseHistoryScope,
} from "@/lib/release-history-cache";

function release(repoFullName: string, tagName: string, publishedAt: string) {
  return { repoFullName, tagName, name: tagName, htmlUrl: "https://example.com", publishedAt, body: null };
}

function line(repoFullName: string, tagName: string, lineKey: string) {
  return { repoFullName, tagName, lineKey, checkedAt: "2026-11-01T00:00:00.000Z" };
}

describe("mergeReleaseHistoryByRepository（#5230）", () => {
  it("受け持ったリポジトリの分だけを差し替え、新しい順に並べ直す", () => {
    const current = {
      entries: [release("o/a", "v1.0.0", "2026-11-01T00:00:00Z"), release("o/b", "v2.0.0", "2026-11-02T00:00:00Z")],
      checkLineRecords: [line("o/a", "v1.0.0", "#1"), line("o/b", "v2.0.0", "#2")],
    };
    const next = mergeReleaseHistoryByRepository(current, {
      repositories: ["o/a"],
      entries: [release("o/a", "v1.1.0", "2026-11-03T00:00:00Z")],
      checkLineRecords: [line("o/a", "v1.1.0", "#3")],
    });
    expect(next.entries.map((e) => e.tagName)).toEqual(["v1.1.0", "v2.0.0"]);
    expect(next.checkLineRecords.map((r) => r.lineKey)).toEqual(["#2", "#3"]);
  });

  it("受け持ったのに1件も無いリポジトリは空にする", () => {
    const next = mergeReleaseHistoryByRepository(
      { entries: [release("o/a", "v1.0.0", "2026-11-01T00:00:00Z")], checkLineRecords: [line("o/a", "v1.0.0", "#1")] },
      { repositories: ["o/a"], entries: [], checkLineRecords: [] },
    );
    expect(next).toEqual({ entries: [], checkLineRecords: [] });
  });

  it("前回の値が無ければ応答をそのまま使う", () => {
    const next = mergeReleaseHistoryByRepository(null, {
      repositories: ["o/a"],
      entries: [release("o/a", "v1.0.0", "2026-11-01T00:00:00Z")],
      checkLineRecords: [],
    });
    expect(next.entries).toHaveLength(1);
  });
});

describe("scopeの判定（#5230）", () => {
  it("未知の値は全部として扱う", () => {
    expect(parseReleaseHistoryScope(null)).toBe("all");
    expect(parseReleaseHistoryScope("x")).toBe("all");
    expect(parseReleaseHistoryScope("targets")).toBe("targets");
  });

  it("確認対象かどうかで母集団を分ける", () => {
    expect(isInReleaseHistoryScope("targets", true)).toBe(true);
    expect(isInReleaseHistoryScope("targets", false)).toBe(false);
    expect(isInReleaseHistoryScope("others", false)).toBe(true);
    expect(isInReleaseHistoryScope("all", false)).toBe(true);
  });
});
