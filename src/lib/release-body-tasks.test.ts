import { describe, expect, it } from "vitest";

import {
  applyReleaseBodyTaskToggle,
  buildCheckLineRecordsFromBodies,
  convertBulletsToTasks,
  parseReleaseBodyTasks,
} from "@/lib/release-body-tasks";

const BODY = [
  "## What's Changed",
  "* 機能A by @u in https://github.com/o/r/pull/1",
  "* 機能B by @u in https://github.com/o/r/pull/2",
  "- 手書きの項目",
  "",
  "使い方: 手で書いた説明",
  "**Full Changelog**: https://github.com/o/r/compare/v1...v2",
].join("\n");

describe("parseReleaseBodyTasks", () => {
  it("通常の箇条書きとタスクリストを拾い、PR参照をkeyにする", () => {
    const tasks = parseReleaseBodyTasks(`${BODY}\n- [x] 機能C by @u in https://github.com/o/r/pull/3`);
    expect(tasks.map((t) => [t.key, t.checked])).toEqual([
      ["https://github.com/o/r/pull/1", null],
      ["https://github.com/o/r/pull/2", null],
      ["手書きの項目", null],
      ["https://github.com/o/r/pull/3", true],
    ]);
  });
});

describe("applyReleaseBodyTaskToggle", () => {
  it("該当行だけを書き換え、ほかの行・説明は変えない", () => {
    const result = applyReleaseBodyTaskToggle(BODY, { key: "https://github.com/o/r/pull/2", checked: true });
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) return;
    expect(result.body.split("\n")).toEqual([
      "## What's Changed",
      "* 機能A by @u in https://github.com/o/r/pull/1",
      "- [x] 機能B by @u in https://github.com/o/r/pull/2",
      "- 手書きの項目",
      "",
      "使い方: 手で書いた説明",
      "**Full Changelog**: https://github.com/o/r/compare/v1...v2",
    ]);
  });

  it("並べ替え・文言変更があってもkeyで同じ行を指す", () => {
    const reordered = "- [ ] 改題した機能B by @u in https://github.com/o/r/pull/2\n- [ ] 機能A by @u in https://github.com/o/r/pull/1";
    const result = applyReleaseBodyTaskToggle(reordered, { key: "https://github.com/o/r/pull/2", checked: true });
    expect(result.ok && result.body.split("\n")[0]).toBe("- [x] 改題した機能B by @u in https://github.com/o/r/pull/2");
  });

  it("オフに戻せる。すでに同じ状態なら変更なし", () => {
    const on = "- [x] x by @u in u1";
    const off = applyReleaseBodyTaskToggle(on, { key: "u1", checked: false });
    expect(off).toEqual({ ok: true, body: "- [ ] x by @u in u1", changed: true });
    expect(applyReleaseBodyTaskToggle(on, { key: "u1", checked: true })).toMatchObject({ changed: false });
  });

  it("同じ参照が複数行あれば同じ項目として揃える。CRLFを保つ", () => {
    const body = "* a by @u in u1\r\n* b by @u in u2\r\n* a by @u in u1\r\n";
    const result = applyReleaseBodyTaskToggle(body, { key: "u1", checked: true });
    expect(result.ok && result.body).toBe("- [x] a by @u in u1\r\n* b by @u in u2\r\n- [x] a by @u in u1\r\n");
  });

  it("見つからない行は書き換えない。引き継ぎ項目は見出しの下へ書き足し、次回は同じ行を更新する", () => {
    expect(applyReleaseBodyTaskToggle(BODY, { key: "nope", checked: true })).toEqual({ ok: false, reason: "line_not_found" });

    const added = applyReleaseBodyTaskToggle(BODY, { key: "v1:機能X", checked: true, text: "機能X", carriedFrom: "v1" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.body).toContain("### v1から引き継いだ変更\n- [x] 機能X <!-- issue-deck:key=v1:機能X -->");
    expect(added.body.startsWith(BODY)).toBe(true);

    const second = applyReleaseBodyTaskToggle(added.body, { key: "v1:機能Y", checked: false, text: "機能Y", carriedFrom: "v1" });
    expect(second.ok && second.body.match(/### v1から/g)?.length).toBe(1);

    const off = applyReleaseBodyTaskToggle(added.body, { key: "v1:機能X", checked: false });
    expect(off.ok && off.body).toContain("- [ ] 機能X <!--");
    expect(parseReleaseBodyTasks(added.body).at(-1)).toMatchObject({ key: "v1:機能X", text: "機能X", carried: true });
  });
});

describe("convertBulletsToTasks", () => {
  it("通常の箇条書きだけ変換し、既存のタスク状態は旧記録で上書きしない", () => {
    const body = "* a by @u in u1\n* b by @u in u2\n- [ ] c by @u in u3\n- [x] d by @u in u4";
    const result = convertBulletsToTasks(body, new Set(["u1", "u3", "u4"]));
    expect(result.body).toBe("- [x] a by @u in u1\n- [ ] b by @u in u2\n- [ ] c by @u in u3\n- [x] d by @u in u4");
    expect(result.convertedCount).toBe(2);
  });
});

describe("buildCheckLineRecordsFromBodies", () => {
  const entry = { repoFullName: "o/r", tagName: "v2", publishedAt: "2026-01-01T00:00:00Z" };
  const legacy = (lineKey: string) => ({ repoFullName: "o/r", tagName: "v2", lineKey, checkedAt: "2025-12-31T00:00:00Z" });

  it("本文のタスクが正。タスクでない行・本文に無い行だけ旧記録を使う", () => {
    const body = "- [x] a by @u in u1\n- [ ] b by @u in u2\n* c by @u in u3";
    const records = buildCheckLineRecordsFromBodies([{ ...entry, body }], [legacy("u2"), legacy("u3"), legacy("v1:x")]);
    expect(records.map((r) => r.lineKey).sort()).toEqual(["u1", "u3", "v1:x"]);
  });

  it("Releaseが無い版は同期済みとして扱わない", () => {
    expect(buildCheckLineRecordsFromBodies([{ ...entry, body: "- [x] a", deployState: "failed" }], [])).toEqual([]);
  });
});
