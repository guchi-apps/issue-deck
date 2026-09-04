import { describe, expect, it } from "vitest";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  extractReleaseHighlights,
  groupReleaseHistoryByJstDate,
  mergeReleaseHistory,
  selectVisibleReleaseHistory,
} from "@/lib/release-history";

function makeEntry(overrides: Partial<ReleaseHistoryItem>): ReleaseHistoryItem {
  return {
    repoFullName: "guchi-apps/issue-deck",
    tagName: "v1.0.0",
    name: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v1.0.0",
    publishedAt: "2026-09-02T05:00:00Z",
    body: null,
    ...overrides,
  };
}

describe("mergeReleaseHistory", () => {
  it("複数リポジトリぶんを公開日時の新しい順へ束ねる", () => {
    const older = makeEntry({ repoFullName: "guchi-apps/myroom", publishedAt: "2026-09-01T00:00:00Z" });
    const newer = makeEntry({ repoFullName: "guchi-apps/issue-deck", publishedAt: "2026-09-02T00:00:00Z" });
    const result = mergeReleaseHistory([[older], [newer]]);
    expect(result.map((entry) => entry.repoFullName)).toEqual([
      "guchi-apps/issue-deck",
      "guchi-apps/myroom",
    ]);
  });

  it("公開時刻が無いエントリは捨てる", () => {
    const result = mergeReleaseHistory([[makeEntry({ publishedAt: null })]]);
    expect(result).toEqual([]);
  });
});

describe("selectVisibleReleaseHistory", () => {
  it("非表示にしたリポジトリのエントリを除く", () => {
    const entries = [
      makeEntry({ repoFullName: "guchi-apps/issue-deck" }),
      makeEntry({ repoFullName: "guchi-apps/myroom" }),
    ];
    const result = selectVisibleReleaseHistory(entries, [
      { fullName: "guchi-apps/myroom", hidden: true },
    ]);
    expect(result.map((entry) => entry.repoFullName)).toEqual(["guchi-apps/issue-deck"]);
  });

  it("非表示のリポジトリが無ければそのまま返す", () => {
    const entries = [makeEntry({})];
    expect(selectVisibleReleaseHistory(entries, [])).toEqual(entries);
  });
});

describe("extractReleaseHighlights", () => {
  it("自動生成された箇条書きから、by @user in ... を落としてタイトルだけにする", () => {
    const body = [
      "## What's Changed",
      "* おまかせモデル選択を追加 by @guchi-apps in guchi-apps/issue-deck#2712",
      "* リリース通知の重複を修正 by @guchi-apps in guchi-apps/issue-deck#2715",
      "",
      "**Full Changelog**: https://github.com/guchi-apps/issue-deck/compare/v4.74.0...v4.75.0",
    ].join("\n");
    expect(extractReleaseHighlights(body)).toEqual({
      lines: ["おまかせモデル選択を追加", "リリース通知の重複を修正"],
      moreCount: 0,
    });
  });

  it("maxを超えるぶんはmoreCountへ回す", () => {
    const body = ["* A by @u in r#1", "* B by @u in r#2", "* C by @u in r#3"].join("\n");
    expect(extractReleaseHighlights(body, 2)).toEqual({ lines: ["A", "B"], moreCount: 1 });
  });

  it("本文が無ければ空を返す", () => {
    expect(extractReleaseHighlights(null)).toEqual({ lines: [], moreCount: 0 });
  });

  it("バージョンバンプだけのPRタイトルは除外する（#2807）", () => {
    const body = [
      "* v4.80.0をリリースする by @issue-deck[bot] in guchi-apps/issue-deck#2801",
      "* 夜間実行を追加する by @m-guchi in guchi-apps/issue-deck#2803",
      "* v4.81.0をmainへリリースする by @issue-deck[bot] in guchi-apps/issue-deck#2806",
    ].join("\n");
    expect(extractReleaseHighlights(body)).toEqual({
      lines: ["夜間実行を追加する"],
      moreCount: 0,
    });
  });
});

describe("groupReleaseHistoryByJstDate", () => {
  it("日本時間の日付でグルーピングする（UTCで日付をまたぐ時刻を含む）", () => {
    const entries = [
      // JST 2026-09-02 14:00
      makeEntry({ repoFullName: "a", publishedAt: "2026-09-02T05:00:00Z" }),
      // JST 2026-09-02 00:30（UTCでは前日9/1）
      makeEntry({ repoFullName: "b", publishedAt: "2026-09-01T15:30:00Z" }),
      // JST 2026-09-01 20:00
      makeEntry({ repoFullName: "c", publishedAt: "2026-09-01T11:00:00Z" }),
    ];
    const groups = groupReleaseHistoryByJstDate(entries);
    expect(groups.map((group) => group.dateKey)).toEqual(["2026-09-02", "2026-09-01"]);
    expect(groups[0].entries.map((entry) => entry.repoFullName)).toEqual(["a", "b"]);
    expect(groups[1].entries.map((entry) => entry.repoFullName)).toEqual(["c"]);
  });
});
