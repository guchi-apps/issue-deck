import { describe, expect, it } from "vitest";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  applyIosReleaseStatuses,
  extractReleaseHighlights,
  groupReleaseHistoryByJstDate,
  mergeReleaseHistory,
  resolveReleasePullRequestId,
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
  it("同じPRが複数回載っていても1行にまとめる（#4287）", () => {
    const body = [
      "* 機能A by @u in https://github.com/o/r/pull/1",
      "* 機能B by @u in https://github.com/o/r/pull/2",
      "* 機能A by @u in https://github.com/o/r/pull/1",
      "* 機能B by @u in https://github.com/o/r/pull/2",
    ].join("\n");
    const result = extractReleaseHighlights(body, 10);
    expect(result.lines.map((line) => line.text)).toEqual(["機能A", "機能B"]);
    expect(result.moreCount).toBe(0);
  });

  it("develop同期とリリース候補のPRは出さない（#5214。v8.89.0の本文）", () => {
    const body = [
      "## What's Changed",
      "- [ ] v8.88.4（main 615411c）の公開をdevelopへ同期する by @issue-deck[bot] in https://github.com/guchi-apps/issue-deck/pull/5204",
      "- [ ] main 615411cの公開をdevelopへ同期する by @issue-deck[bot] in https://github.com/guchi-apps/issue-deck/pull/5203",
      "- [ ] iOSアプリのアイコンバッジと設定画面のオン・オフを追加する #5203 by @m-guchi in https://github.com/guchi-apps/issue-deck/pull/5205",
      "- [ ] リリース候補 RC-41 by @issue-deck[bot] in https://github.com/guchi-apps/issue-deck/pull/5206",
    ].join("\n");
    expect(extractReleaseHighlights(body, 10).lines.map((line) => line.text)).toEqual([
      "iOSアプリのアイコンバッジと設定画面のオン・オフを追加する #5203",
    ]);
  });

  it("同期やリリース候補を題材にした通常のPRは残す（#5214）", () => {
    const titles = [
      "同期PRのGitHubオートマージを有効にしない #5151",
      "develop同期PRを、CIの実行中にGitHubのオートマージへ任せる",
      "リリース候補の修正対応中・停止をブランチ画面に表示する #4972",
      "RCへ後から取り込んだ修正PRをブランチ画面のリリース候補に表示する #5103",
    ];
    const body = titles.map((title, index) => `* ${title} by @u in https://github.com/o/r/pull/${index + 1}`).join("\n");
    expect(extractReleaseHighlights(body, 10).lines.map((line) => line.text)).toEqual(titles);
  });

  it("自動生成された箇条書きから、by @user in ... を落としてタイトルだけにする", () => {
    const body = [
      "## What's Changed",
      "* おまかせモデル選択を追加 by @guchi-apps in guchi-apps/issue-deck#2712",
      "* リリース通知の重複を修正 by @guchi-apps in guchi-apps/issue-deck#2715",
      "",
      "**Full Changelog**: https://github.com/guchi-apps/issue-deck/compare/v4.74.0...v4.75.0",
    ].join("\n");
    expect(extractReleaseHighlights(body)).toEqual({
      lines: [
        { text: "おまかせモデル選択を追加", key: "guchi-apps/issue-deck#2712" },
        { text: "リリース通知の重複を修正", key: "guchi-apps/issue-deck#2715" },
      ],
      moreCount: 0,
    });
  });

  it("maxを超えるぶんはmoreCountへ回す", () => {
    const body = ["* A by @u in r#1", "* B by @u in r#2", "* C by @u in r#3"].join("\n");
    expect(extractReleaseHighlights(body, 2)).toEqual({
      lines: [
        { text: "A", key: "r#1" },
        { text: "B", key: "r#2" },
      ],
      moreCount: 1,
    });
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
      lines: [{ text: "夜間実行を追加する", key: "guchi-apps/issue-deck#2803" }],
      moreCount: 0,
    });
  });

  it("PRの参照を取り出せない手書きの行は、テキスト自体を識別子にする（#2982）", () => {
    expect(extractReleaseHighlights("* 手書きのメモ書き")).toEqual({
      lines: [{ text: "手書きのメモ書き", key: "手書きのメモ書き" }],
      moreCount: 0,
    });
  });
});

describe("resolveReleasePullRequestId", () => {
  it("GitHubの自動生成本文のPR URLをPR idへ変える", () => {
    expect(
      resolveReleasePullRequestId("https://github.com/guchi-apps/issue-deck/pull/3114", "guchi-apps/issue-deck"),
    ).toBe("guchi-apps/issue-deck#3114");
  });

  it("owner/repo#123形式はそのまま返し、#123はリリースを持つリポジトリのPRとみなす", () => {
    expect(resolveReleasePullRequestId("guchi-apps/issue-deck#2712", "guchi-apps/other")).toBe(
      "guchi-apps/issue-deck#2712",
    );
    expect(resolveReleasePullRequestId("#42", "guchi-apps/car-care")).toBe("guchi-apps/car-care#42");
  });

  it("手書きの行（keyが本文そのもの）・Issue URL・オーナー無しの参照はnull", () => {
    expect(resolveReleasePullRequestId("手書きのメモ書き", "guchi-apps/issue-deck")).toBeNull();
    expect(
      resolveReleasePullRequestId("https://github.com/guchi-apps/issue-deck/issues/10", "guchi-apps/issue-deck"),
    ).toBeNull();
    expect(resolveReleasePullRequestId("r#1", "guchi-apps/issue-deck")).toBeNull();
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

describe("applyIosReleaseStatuses（#5214）", () => {
  const entry = (repoFullName: string, tagName: string): ReleaseHistoryItem => ({
    repoFullName,
    tagName,
    name: tagName,
    htmlUrl: `https://example.com/${tagName}`,
    publishedAt: "2026-11-04T00:00:00Z",
    body: null,
  });

  it("配布済み・失敗・自動配布なしを版ごとに重ね、成功を失敗より優先する", () => {
    const result = applyIosReleaseStatuses(
      [entry("o/a", "v3"), entry("o/a", "v2"), entry("o/a", "v1"), entry("o/a", "v0")],
      [
        {
          repoFullName: "o/a",
          delivered: { v3: 10, v0: 7 },
          failed: { v2: "アップロード", v1: null, v0: "ビルド" },
          hasActiveRun: false,
        },
      ],
    );
    expect(result[0].iosDeliveredBuild).toBe(10);
    expect(result[1].iosFailureStage).toBe("アップロード");
    expect(result[2].iosFailureStage).toBeNull();
    expect(result[3].iosDeliveredBuild).toBe(7);
    expect(result[3].iosFailureStage).toBeUndefined();
  });

  it("配布が実行中のリポジトリでは「自動配布なし」を付けない", () => {
    const status = { repoFullName: "o/a", delivered: {}, failed: {} };
    expect(applyIosReleaseStatuses([entry("o/a", "v1")], [{ ...status, hasActiveRun: true }])[0].iosNotDistributed).toBeUndefined();
    expect(applyIosReleaseStatuses([entry("o/a", "v1")], [{ ...status, hasActiveRun: false }])[0].iosNotDistributed).toBe(true);
  });

  it("状況の届いていないリポジトリの版はそのまま返す", () => {
    const original = entry("o/b", "v1");
    const result = applyIosReleaseStatuses(
      [original],
      [{ repoFullName: "o/a", delivered: {}, failed: {}, hasActiveRun: false }],
    );
    expect(result[0]).toBe(original);
  });
});
