import { describe, expect, it } from "vitest";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import { buildReleaseCheckIndex, countUncheckedReleases, resolveReleaseCheckStatus } from "@/lib/release-check";
import { extractReleaseHighlights } from "@/lib/release-history";
import {
  applyRecoveryLinks,
  findPreviousVersionTag,
  parseReleaseNotesSnapshot,
  planRecoveryLinks,
  resolveUnreleasedDeployState,
  selectUnreleasedTags,
  toVersionTags,
} from "@/lib/release-recovery";

function makeEntry(overrides: Partial<ReleaseHistoryItem> = {}): ReleaseHistoryItem {
  return {
    repoFullName: "guchi-apps/issue-deck",
    tagName: "v1.0.0",
    name: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v1.0.0",
    publishedAt: "2026-10-05T05:00:00Z",
    body: null,
    ...overrides,
  };
}

// v8.34.0の`.github/release-notes.md`（タグv8.34.0・v8.34.1のどちらでも同じ内容だった）
const V8_34_0_NOTES = `<!-- リリースのたびに自動生成されます。手で編集しないでください（guchi-apps/issue-deck#2391） -->

# v8.34.0

- PRの自動修復を繰り返し実行できるようになりました。
- 設定の実行設定で、AI実行に使うプロバイダーをまとめて切り替えられるようになりました。

**使い方**

1. 設定ダイアログの「実行設定」を開きます。
2. 修復が必要なPRの詳細を開き、修復ボタンを押します。
`;

describe("parseReleaseNotesSnapshot", () => {
  it("見出しが版と一致すれば、変更と使い方を分けて取り出す", () => {
    expect(parseReleaseNotesSnapshot(V8_34_0_NOTES, "v8.34.0")).toEqual({
      status: "ok",
      changes: [
        "PRの自動修復を繰り返し実行できるようになりました。",
        "設定の実行設定で、AI実行に使うプロバイダーをまとめて切り替えられるようになりました。",
      ],
      usage: ["1. 設定ダイアログの「実行設定」を開きます。", "2. 修復が必要なPRの詳細を開き、修復ボタンを押します。"],
    });
  });

  it("見出しが前の版のまま残っていれば、その説明をこの版のものとして使わない", () => {
    const snapshot = parseReleaseNotesSnapshot(V8_34_0_NOTES, "v8.34.1");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.status === "unavailable" && snapshot.reason).toContain("v8.34.0");
  });

  it("ファイルが無い・本文が無いときは理由付きで取得不能にする（空欄にしない）", () => {
    expect(parseReleaseNotesSnapshot(null, "v1.0.0").status).toBe("unavailable");
    expect(parseReleaseNotesSnapshot("# v1.0.0\n\n", "v1.0.0").status).toBe("unavailable");
    expect(parseReleaseNotesSnapshot("本文だけ", "v1.0.0").status).toBe("unavailable");
  });
});

describe("selectUnreleasedTags", () => {
  const tags = toVersionTags([
    { ref: "refs/tags/v8.33.1", sha: "a" },
    { ref: "refs/tags/v8.34.0", sha: "b" },
    { ref: "refs/tags/v8.34.1", sha: "c" },
    { ref: "refs/tags/v8.34.2-rc.1", sha: "d" },
    { ref: "refs/tags/ios-build-12", sha: "e" },
  ]);

  it("Releaseのある範囲で、Releaseの無い版のタグだけを返す", () => {
    const releases = [makeEntry({ tagName: "v8.34.1" }), makeEntry({ tagName: "v8.33.1" })];
    expect(selectUnreleasedTags(tags, releases)).toEqual([{ tagName: "v8.34.0", sha: "b" }]);
  });

  it("取得したReleaseより古いタグ・Releaseが無いリポジトリでは補わない", () => {
    expect(selectUnreleasedTags(tags, [makeEntry({ tagName: "v8.34.1" })])).toEqual([]);
    expect(selectUnreleasedTags(tags, [])).toEqual([]);
  });

  it("直前の版を差分の起点にする", () => {
    expect(findPreviousVersionTag(tags, "v8.34.1")).toBe("v8.34.0");
    expect(findPreviousVersionTag(tags, "v8.33.1")).toBeNull();
  });
});

describe("resolveUnreleasedDeployState", () => {
  it("実行の結果から状態を決め、分からないものは成功にも失敗にもしない", () => {
    expect(resolveUnreleasedDeployState({ status: "completed", conclusion: "failure" })).toBe("failed");
    expect(resolveUnreleasedDeployState({ status: "in_progress", conclusion: null })).toBe("in_progress");
    expect(resolveUnreleasedDeployState({ status: "completed", conclusion: "success" })).toBe(
      "succeeded_without_release",
    );
    expect(resolveUnreleasedDeployState({ status: "completed", conclusion: "cancelled" })).toBe("unknown");
    expect(resolveUnreleasedDeployState(null)).toBe("unknown");
  });
});

const FAILED_BODY = `## What's Changed
* v8.34.0をリリースする by @issue-deck[bot] in https://github.com/guchi-apps/issue-deck/pull/3992
* PR自動修復を繰り返す by @m-guchi in https://github.com/guchi-apps/issue-deck/pull/3980
`;
const RECOVERY_BODY = `## What's Changed
* PR自動修復テーブルのマイグレーション失敗を復旧する by @m-guchi in https://github.com/guchi-apps/issue-deck/pull/3997
`;

describe("planRecoveryLinks / applyRecoveryLinks", () => {
  it("v8.34.0失敗→v8.34.1成功: 修正版に元の説明とPRが付き、元版から修正版を辿れる", () => {
    const failed = makeEntry({
      tagName: "v8.34.0",
      deployState: "failed",
      releaseNotes: parseReleaseNotesSnapshot(V8_34_0_NOTES, "v8.34.0"),
      body: FAILED_BODY,
    });
    const recovery = makeEntry({ tagName: "v8.34.1", body: RECOVERY_BODY });
    const normal = makeEntry({ tagName: "v8.33.1" });
    const entries = [recovery, normal, failed];

    const pairs = planRecoveryLinks(entries);
    expect(pairs).toEqual([{ failed: "v8.34.0", recovery: "v8.34.1" }]);

    const linked = applyRecoveryLinks(entries, pairs);
    const byTag = new Map(linked.map((entry) => [entry.tagName, entry]));
    expect(byTag.get("v8.34.0")?.recoveredBy).toBe("v8.34.1");
    const carried = byTag.get("v8.34.1")?.carriedOver;
    expect(carried?.map((item) => item.tagName)).toEqual(["v8.34.0"]);
    expect(carried?.[0].releaseNotes.status).toBe("ok");
    // 修正版自身の本文（追加した修正）は上書きしない
    expect(byTag.get("v8.34.1")?.body).toBe(RECOVERY_BODY);
    // 引き継いだPRと追加した修正は重ならない
    const carriedKeys = extractReleaseHighlights(carried?.[0].body ?? null, Infinity).lines.map((l) => l.key);
    const ownKeys = extractReleaseHighlights(RECOVERY_BODY, Infinity).lines.map((l) => l.key);
    expect(carriedKeys.filter((key) => ownKeys.includes(key))).toEqual([]);
    // 通常の版には何も付かない
    expect(byTag.get("v8.33.1")).toEqual(normal);
  });

  it("修正が再び失敗しても、成功した版へ各失敗版を1回ずつだけ引き継ぐ", () => {
    const entries = [
      makeEntry({ tagName: "v8.34.2" }),
      makeEntry({ tagName: "v8.34.1", deployState: "failed", body: RECOVERY_BODY }),
      makeEntry({ tagName: "v8.34.0", deployState: "failed", body: FAILED_BODY }),
    ];
    const pairs = planRecoveryLinks(entries);
    expect(pairs).toEqual([
      { failed: "v8.34.0", recovery: "v8.34.2" },
      { failed: "v8.34.1", recovery: "v8.34.2" },
    ]);
    const linked = applyRecoveryLinks(entries, pairs);
    const byTag = new Map(linked.map((entry) => [entry.tagName, entry]));
    expect(byTag.get("v8.34.2")?.carriedOver?.map((item) => item.tagName)).toEqual(["v8.34.0", "v8.34.1"]);
    // 失敗版どうしは引き継ぎを持たない（同じ項目が増殖しない）
    expect(byTag.get("v8.34.1")?.carriedOver).toBeUndefined();
    expect(byTag.get("v8.34.0")?.recoveredBy).toBe("v8.34.2");
    expect(byTag.get("v8.34.1")?.recoveredBy).toBe("v8.34.2");
  });

  it("デプロイ中・結果不明の版は届けた版とみなさず、まだ成功が無ければ紐付けない", () => {
    expect(
      planRecoveryLinks([
        makeEntry({ tagName: "v1.0.0", deployState: "failed" }),
        makeEntry({ tagName: "v1.0.1", deployState: "in_progress" }),
        makeEntry({ tagName: "v1.0.2", deployState: "unknown" }),
      ]),
    ).toEqual([]);
  });

  it("祖先関係を確かめられなかった組は使わない（版の並びだけで関係を言い切らない）", () => {
    const entries = [makeEntry({ tagName: "v1.0.1" }), makeEntry({ tagName: "v1.0.0", deployState: "failed" })];
    const linked = applyRecoveryLinks(entries, []);
    expect(linked.find((entry) => entry.tagName === "v1.0.0")?.recoveredBy).toBeUndefined();
    expect(linked.find((entry) => entry.tagName === "v1.0.1")?.carriedOver).toBeUndefined();
  });

  it("失敗の無い通常のリリース・同じ版の出し直しでは何も紐付けない", () => {
    expect(planRecoveryLinks([makeEntry({ tagName: "v1.0.1" }), makeEntry({ tagName: "v1.0.0" })])).toEqual([]);
  });
});

describe("動作確認との整合", () => {
  it("Releaseが無い版は未確認に数えず、件数は届けた版の1件だけ", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: "2026-10-01T00:00:00Z" }],
      [],
    );
    const entries = [
      makeEntry({ tagName: "v8.34.1" }),
      makeEntry({ tagName: "v8.34.0", deployState: "failed" }),
    ];
    expect(resolveReleaseCheckStatus(entries[1], index).kind).toBe("out_of_scope");
    expect(countUncheckedReleases(entries, index)).toBe(1);
  });
});
