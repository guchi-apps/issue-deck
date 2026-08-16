import { describe, expect, it } from "vitest";

import {
  CHANGELOG_PLACEHOLDER,
  insertChangelogEntry,
  parseReleaseChangelog,
  parseReleaseUsage,
} from "./version-changelog.mjs";

const BASE = `export const APP_CHANGELOG: ChangelogEntry[] = [
  {
    version: "3.29.0",
    date: "2026-08-16",
    changes: ["既存の項目"],
  },
];
`;

describe("parseReleaseChangelog", () => {
  it("箇条書き記号と番号を落として1行1項目にする", () => {
    const raw = "- Issueを作成できるようになりました\n* PRの一覧を出すようにしました\n1. 通知を直しました";
    expect(parseReleaseChangelog(raw)).toEqual([
      "Issueを作成できるようになりました",
      "PRの一覧を出すようにしました",
      "通知を直しました",
    ]);
  });

  it("空行を落とし、未設定なら空配列を返す", () => {
    expect(parseReleaseChangelog("行1\n\n  \n行2")).toEqual(["行1", "行2"]);
    expect(parseReleaseChangelog(undefined)).toEqual([]);
  });
});

describe("parseReleaseUsage", () => {
  // usageは「1. 」で始まる番号付きの複数行で渡る契約のため、番号を落とさず行を保つ
  it("番号を落とさず1行1項目にする", () => {
    const raw = "1. 設定を開く\n2. 更新履歴を押す\n3. 一覧が出れば成功";
    expect(parseReleaseUsage(raw)).toEqual([
      "1. 設定を開く",
      "2. 更新履歴を押す",
      "3. 一覧が出れば成功",
    ]);
  });

  it("画面で使える変化が無いリリースでは空配列になる", () => {
    expect(parseReleaseUsage("")).toEqual([]);
    expect(parseReleaseUsage(undefined)).toEqual([]);
  });
});

describe("insertChangelogEntry", () => {
  it("配列の先頭へ新しいエントリを挿入する", () => {
    const { content, inserted } = insertChangelogEntry(BASE, "3.30.0", "2026-08-17", ["直しました"]);

    expect(inserted).toBe(true);
    expect(content.indexOf('version: "3.30.0"')).toBeLessThan(content.indexOf('version: "3.29.0"'));
    expect(content).toContain('date: "2026-08-17"');
    expect(content).toContain('"直しました",');
  });

  it("usageがあれば別の項目として持たせる", () => {
    const { content } = insertChangelogEntry(
      BASE,
      "3.30.0",
      "2026-08-17",
      ["直しました"],
      ["1. 設定を開く", "2. 更新履歴を押す"],
    );

    expect(content).toContain("usage: [");
    expect(content).toContain('"1. 設定を開く",');
    expect(content).toContain('"2. 更新履歴を押す",');
  });

  it("usageが空なら項目ごと書かない", () => {
    const { content } = insertChangelogEntry(BASE, "3.30.0", "2026-08-17", ["直しました"], []);

    expect(content).not.toContain("usage: [");
  });

  it("changelogが空なら手で埋めるための枠を作る", () => {
    const { content } = insertChangelogEntry(BASE, "3.30.0", "2026-08-17", [], []);

    expect(content).toContain(CHANGELOG_PLACEHOLDER);
  });

  it("同じバージョンが既にあれば何もしない", () => {
    const { content, inserted } = insertChangelogEntry(BASE, "3.29.0", "2026-08-17", ["直しました"]);

    expect(inserted).toBe(false);
    expect(content).toBe(BASE);
  });

  it("ダブルクォートとバックスラッシュをエスケープする", () => {
    const { content } = insertChangelogEntry(BASE, "3.30.0", "2026-08-17", ['「"実装"」\\を直した']);

    expect(content).toContain('\\"実装\\"');
    expect(content).toContain("\\\\を直した");
  });

  it("目印が無ければ失敗させる", () => {
    expect(() => insertChangelogEntry("const other = [];", "3.30.0", "2026-08-17", [])).toThrow();
  });
});
