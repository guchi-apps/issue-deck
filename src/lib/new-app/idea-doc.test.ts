import { describe, expect, it } from "vitest";

import {
  applyIdeaImport,
  isIdeaClosed,
  isIdeaDocPath,
  parseIdeaDoc,
} from "@/lib/new-app/idea-doc";
import { emptyNewAppSpec } from "@/lib/new-app/spec";

/**
 * 構想メモから仕様案を読む（#2432）。
 *
 * 確かめるのは3つ。**雛形のままの行を値として取り込まないこと**、
 * **埋まっている行だけを読み取ること**、**解釈できない値で全体を捨てないこと**。
 */

/** `guchi-apps/ideas`の`templates/idea.md`の「仕様案」の表（2026-08-28時点）。 */
const TEMPLATE_TABLE = `## 仕様案

| 項目 | 値 | メモ |
|---|---|---|
| アプリ名（画面に出る名前。日本語可） | | |
| リポジトリ名（\`guchi-apps/<これ>\`。ASCIIのケバブケース） | | |
| 公開範囲 | public / private | |
| 概要（1行。リポジトリのdescriptionになる） | | |
| 種別 | Next.js + DB / Next.js / FastAPI / 静的サイト | |
| 公開URLの取り方 | サブドメイン / パス | |
| サブドメイン または パス | | \`<これ>.gucchii.com\` / \`gucchii.com/<これ>\` |
| 本番ポート | | 静的サイトなら無し |
| DB名（MariaDB） | | DBを使わないなら無し |
| ログイン | 無し / Supabase + Google / FastAPI + Google | |
| マルチエージェント運用（issue-deck）に対応させるか | はい / いいえ | |
| ブラウザのタブに出る名前 | | 空ならアプリ名をそのまま使う |
| PWA対応 | する / しない | 標準は「する」 |
| オフライン対応 | する / しない | 標準は「しない」 |
| アイコンとテーマカラー | 暫定で始める / 用意してから始める | 標準は「暫定で始める」 |
| テーマカラー | \`#0f172a\` | |
| 更新履歴（changelog）を持つか | はい / いいえ | |
| CI撮影の認証バイパスを用意するか | はい / いいえ | ログインが無いアプリでは意味を持たない |
`;

const TEMPLATE = `# <構想の名前>

- 状態: 検討中 / 立ち上げ済み（\`guchi-apps/<repo>\`） / 見送り
- 起点Issue: #<番号>

## 一言でいうと

<1〜2行。誰の何をどう楽にするのか>

${TEMPLATE_TABLE}`;

const FILLED = `# 家計レポート

- 状態: 検討中
- 起点Issue: #2440
- 最終更新: 2026-08-28

## 一言でいうと

Zaimの明細から月次の推移を自動で作り、手作業の集計をやめる。

## 仕様案

| 項目 | 値 | メモ |
|---|---|---|
| アプリ名（画面に出る名前。日本語可） | 家計レポート | |
| リポジトリ名（\`guchi-apps/<これ>\`。ASCIIのケバブケース） | kakei-report | |
| 公開範囲 | private | |
| 概要（1行。リポジトリのdescriptionになる） | 家計の月次推移をZaimのデータから作る | |
| 種別 | Next.js + DB | |
| 公開URLの取り方 | サブドメイン | |
| サブドメイン または パス | kakei-report | |
| 本番ポート | 3112 | |
| DB名（MariaDB） | app_kakei_report | |
| ログイン | Supabase + Google | |
| マルチエージェント運用（issue-deck）に対応させるか | はい | |
| ブラウザのタブに出る名前 | | 空ならアプリ名をそのまま使う |
| PWA対応 | する | |
| オフライン対応 | しない | |
| アイコンとテーマカラー | 暫定で始める | |
| テーマカラー | \`#0f766e\` | |
| 更新履歴（changelog）を持つか | はい | |
| CI撮影の認証バイパスを用意するか | はい | |

## 次にやること

- [ ] 決める
`;

describe("parseIdeaDoc", () => {
  it("雛形のままの表からは値を1つも取り込まない", () => {
    const result = parseIdeaDoc(TEMPLATE);

    expect(result.hasSpecTable).toBe(true);
    expect(result.values).toEqual({ themeColor: "#0f172a" });
    // 見出しもプレースホルダなのでアプリ名は埋まらない
    expect(result.title).toBeNull();
    expect(result.filled.map((field) => field.key)).toEqual(["themeColor"]);
    expect(result.unreadable).toEqual([]);
    // 選択肢がそのまま残っている行は「未決」として並ぶ
    expect(result.undecided).toContain("公開範囲");
    expect(result.undecided).toContain("種別");
    expect(result.undecided).toContain("ログイン");
    expect(result.undecided).toContain("PWA対応");
    expect(result.undecided).toContain("アイコンとテーマカラー");
    expect(result.undecided).toContain("アプリ名");
  });

  it("埋まっている構想メモから仕様案を読む", () => {
    const result = parseIdeaDoc(FILLED);

    expect(result.title).toBe("家計レポート");
    expect(result.state).toBe("検討中");
    expect(result.values).toEqual({
      displayName: "家計レポート",
      repositoryName: "kakei-report",
      visibility: "private",
      summary: "家計の月次推移をZaimのデータから作る",
      kind: "next-db",
      urlMode: "subdomain",
      subdomain: "kakei-report",
      port: 3112,
      databaseName: "app_kakei_report",
      auth: "supabase-google",
      multiAgent: true,
      pwa: true,
      offline: false,
      iconPlan: "provisional",
      themeColor: "#0f766e",
      changelog: true,
      screenshotBypass: true,
    });
    expect(result.unreadable).toEqual([]);
    // 空欄の行だけが未決として残る
    expect(result.undecided).toEqual(["ブラウザのタブに出る名前"]);
    expect(result.filled.find((field) => field.key === "kind")?.display).toBe("Next.js + DB");
    expect(result.filled.find((field) => field.key === "placement")?.display).toBe(
      "kakei-report（サブドメイン）",
    );
  });

  it("公開URLの取り方がパスなら、同じ行をbasePathへ入れる", () => {
    const result = parseIdeaDoc(`## 仕様案

| 項目 | 値 |
|---|---|
| 公開URLの取り方 | パス |
| サブドメイン または パス | kakei-report |
`);

    expect(result.values.urlMode).toBe("path");
    expect(result.values.basePath).toBe("kakei-report");
    expect(result.values.subdomain).toBeUndefined();
  });

  it("解釈できない値はその項目だけを落とし、他は読む", () => {
    const result = parseIdeaDoc(`## 仕様案

| 項目 | 値 |
|---|---|
| 種別 | Rails |
| リポジトリ名 | Kakei_Report |
| 本番ポート | 未決 |
| 公開範囲 | private |
`);

    expect(result.values).toEqual({ visibility: "private" });
    // 並びは表の行順ではなく読み取り順（画面に出す項目の並び）
    expect(result.unreadable).toEqual([
      { label: "リポジトリ名", raw: "Kakei_Report" },
      { label: "種別", raw: "Rails" },
    ]);
    expect(result.undecided).toEqual(["本番ポート"]);
  });

  it("ポートとDB名の「無し」は空欄と区別して読む", () => {
    const result = parseIdeaDoc(`## 仕様案

| 項目 | 値 |
|---|---|
| 本番ポート | 無し |
| DB名（MariaDB） | なし |
`);

    expect(result.values).toEqual({ port: null, databaseName: null });
    expect(result.undecided).toEqual([]);
    expect(result.filled.map((field) => field.display)).toEqual(["無し", "無し"]);
  });

  it("アプリ名と概要が空欄なら、見出しと「一言でいうと」で埋める", () => {
    const result = parseIdeaDoc(`# 買い物メモ

## 一言でいうと

買う物をスマホから足して、レジで消す。

## 仕様案

| 項目 | 値 |
|---|---|
| アプリ名 | |
| 概要 | |
`);

    expect(result.values.displayName).toBe("買い物メモ");
    expect(result.values.summary).toBe("買う物をスマホから足して、レジで消す。");
    expect(result.undecided).toEqual([]);
  });

  it("仕様案の表が無くても、読めた範囲だけを返す", () => {
    const result = parseIdeaDoc("# 買い物メモ\n\n- 状態: 見送り\n");

    expect(result.hasSpecTable).toBe(false);
    expect(result.values.displayName).toBe("買い物メモ");
    expect(result.state).toBe("見送り");
  });

  it("見出しが無くても、項目と値の表を見つける", () => {
    const result = parseIdeaDoc(`| 項目 | 値 |
|---|---|
| 種別 | FastAPI |
`);

    expect(result.hasSpecTable).toBe(true);
    expect(result.values.kind).toBe("fastapi");
  });
});

describe("isIdeaClosed", () => {
  it("立ち上げ済み・見送りだけを閉じた構想とみなす", () => {
    expect(isIdeaClosed("検討中")).toBe(false);
    expect(isIdeaClosed(null)).toBe(false);
    expect(isIdeaClosed("立ち上げ済み（guchi-apps/kakei-report）")).toBe(true);
    expect(isIdeaClosed("見送り")).toBe(true);
    // 雛形のまま（選択肢が並んでいる）なら注意を出さない
    expect(isIdeaClosed("検討中 / 立ち上げ済み（`guchi-apps/<repo>`） / 見送り")).toBe(false);
  });
});

describe("applyIdeaImport", () => {
  it("読み取れた値だけを重ね、DB名とサブドメインは足りなければ補う", () => {
    const next = applyIdeaImport(emptyNewAppSpec(), {
      displayName: "家計レポート",
      repositoryName: "kakei-report",
      kind: "next-db",
    });

    expect(next.displayName).toBe("家計レポート");
    expect(next.databaseName).toBe("app_kakei_report");
    expect(next.subdomain).toBe("kakei-report");
    // 触れていない項目は既定のまま
    expect(next.pwa).toBe(true);
    expect(next.visibility).toBe("private");
  });

  it("DBを使わない種別ではDB名を落とす", () => {
    const next = applyIdeaImport(emptyNewAppSpec(), {
      repositoryName: "solitaire",
      kind: "static",
      databaseName: "app_solitaire",
    });

    expect(next.databaseName).toBeNull();
  });

  it("パス配下ならbasePathを補う", () => {
    const next = applyIdeaImport(emptyNewAppSpec(), {
      repositoryName: "kakei-report",
      urlMode: "path",
    });

    expect(next.basePath).toBe("kakei-report");
  });
});

describe("isIdeaDocPath", () => {
  it("ideas配下のMarkdownだけを通す", () => {
    expect(isIdeaDocPath("ideas/kakei-report/README.md")).toBe(true);
    expect(isIdeaDocPath("ideas/kakei-report/screens.md")).toBe(true);
  });

  it("構想メモ以外のパスは弾く", () => {
    expect(isIdeaDocPath("CLAUDE.md")).toBe(false);
    expect(isIdeaDocPath("templates/idea.md")).toBe(false);
    expect(isIdeaDocPath("ideas/kakei-report/README.txt")).toBe(false);
    expect(isIdeaDocPath("ideas/../CLAUDE.md")).toBe(false);
    expect(isIdeaDocPath("/etc/passwd")).toBe(false);
  });
});
