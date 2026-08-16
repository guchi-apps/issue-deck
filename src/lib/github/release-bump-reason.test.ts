import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractBumpChangelog,
  extractBumpReason,
  extractBumpUsage,
} from "@/lib/github/release-bump-reason";

describe("extractBumpReason", () => {
  it("バージョンの判断根拠セクションのテキストを抜き出す", () => {
    const body = [
      "developへの取り込み待ちの変更を v1.11.0 としてリリースします。",
      "",
      "## バージョンの判断根拠",
      "コード差分の内容からminorバージョンと判定しました。",
      "",
      "新機能としてXXXを追加したためminorと判定しました。",
      "",
      "判断が誤っていると思われる場合は、このPR上でバージョンを修正してください。",
      "",
      "## 対象issue",
      "- #123 foo",
      "",
      "## 注意点",
      "- このPRはGitHub Actionsが自動作成しました",
    ].join("\n");

    expect(extractBumpReason(body)).toBe(
      [
        "コード差分の内容からminorバージョンと判定しました。",
        "",
        "新機能としてXXXを追加したためminorと判定しました。",
        "",
        "判断が誤っていると思われる場合は、このPR上でバージョンを修正してください。",
      ].join("\n"),
    );
  });

  it("見出しが無い本文ではnullを返す", () => {
    expect(extractBumpReason("developへの取り込み待ちの変更をリリースします。")).toBeNull();
  });

  it("bodyがnull・undefined・空文字の場合はnullを返す", () => {
    expect(extractBumpReason(null)).toBeNull();
    expect(extractBumpReason(undefined)).toBeNull();
    expect(extractBumpReason("")).toBeNull();
  });

  it("見出し以降が空白のみの場合はnullを返す", () => {
    const body = "## バージョンの判断根拠\n\n## 対象issue\n- #1 foo";
    expect(extractBumpReason(body)).toBeNull();
  });
});

describe("extractBumpChangelog", () => {
  it("更新履歴（生成された利用者向け文言）セクションのテキストを抜き出す", () => {
    const body = [
      "developへの取り込み待ちの変更を v1.11.0 としてリリースします。",
      "",
      "## バージョンの判断根拠",
      "コード差分の内容からminorバージョンと判定しました。",
      "",
      "判断が誤っていると思われる場合は、このPR上でバージョンを修正してください。",
      "",
      "## 更新履歴（生成された利用者向け文言）",
      "",
      "- XXXを追加しました",
      "- YYYを修正しました",
      "",
      "## 対象issue",
      "- #123 foo",
      "",
      "## 注意点",
      "- このPRはGitHub Actionsが自動作成しました",
    ].join("\n");

    expect(extractBumpChangelog(body)).toBe(["- XXXを追加しました", "- YYYを修正しました"].join("\n"));
  });

  it("見出しが無い本文ではnullを返す", () => {
    expect(extractBumpChangelog("developへの取り込み待ちの変更をリリースします。")).toBeNull();
  });

  it("bodyがnull・undefined・空文字の場合はnullを返す", () => {
    expect(extractBumpChangelog(null)).toBeNull();
    expect(extractBumpChangelog(undefined)).toBeNull();
    expect(extractBumpChangelog("")).toBeNull();
  });

  it("見出し以降が空白のみの場合はnullを返す", () => {
    const body = "## 更新履歴（生成された利用者向け文言）\n\n## 対象issue\n- #1 foo";
    expect(extractBumpChangelog(body)).toBeNull();
  });
});

describe("extractBumpUsage", () => {
  // 使い方は更新履歴の直後に置かれる（reusable-release-develop-to-main.ymlのPR本文テンプレート）。
  // 隣り合う2セクションを取り違えないことが要点なので、両方を含む本文で確かめる
  const bodyWithBoth = [
    "developへの取り込み待ちの変更を v1.11.0 としてリリースします。",
    "",
    "## バージョンの判断根拠",
    "コード差分の内容からminorバージョンと判定しました。",
    "",
    "## 更新履歴（生成された利用者向け文言）",
    "",
    "買い物リストを家族と共有できるようになりました。",
    "",
    "## 使い方（生成された利用者向け文言）",
    "",
    "1. 共有したいリストを開き、右上の「共有」を押す",
    "2. 表示されたリンクを相手に送る",
    "3. リストの名前の横に人数のバッジが出れば共有できている",
    "",
    "## 対象issue",
    "- #123 foo",
  ].join("\n");

  it("使い方（生成された利用者向け文言）セクションのテキストを抜き出す", () => {
    expect(extractBumpUsage(bodyWithBoth)).toBe(
      [
        "1. 共有したいリストを開き、右上の「共有」を押す",
        "2. 表示されたリンクを相手に送る",
        "3. リストの名前の横に人数のバッジが出れば共有できている",
      ].join("\n"),
    );
  });

  it("直前の更新履歴セクションは使い方の見出しで終わる", () => {
    expect(extractBumpChangelog(bodyWithBoth)).toBe("買い物リストを家族と共有できるようになりました。");
  });

  it("画面で使える変化が無いリリース（セクションが無い本文）ではnullを返す", () => {
    const body = [
      "## 更新履歴（生成された利用者向け文言）",
      "",
      "内部構造を変更しました。",
      "",
      "## 対象issue",
      "- #123 foo",
    ].join("\n");
    expect(extractBumpUsage(body)).toBeNull();
  });

  it("bodyがnull・undefined・空文字の場合はnullを返す", () => {
    expect(extractBumpUsage(null)).toBeNull();
    expect(extractBumpUsage(undefined)).toBeNull();
    expect(extractBumpUsage("")).toBeNull();
  });

  it("見出し以降が空白のみの場合はnullを返す", () => {
    const body = "## 使い方（生成された利用者向け文言）\n\n## 対象issue\n- #1 foo";
    expect(extractBumpUsage(body)).toBeNull();
  });
});

// 抽出関数が探す見出しは、バンプPR本文を組み立てるワークフロー側の文言と一字一句そろっている
// 必要がある。ずれても型エラーにも実行時エラーにもならず、画面から黙って消えるだけなので、
// 実ファイルを読んで固定する（#1729）。
describe("バンプPR本文の見出しとワークフローの契約", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "reusable-release-develop-to-main.yml"),
    "utf8",
  );

  it.each([
    ["## バージョンの判断根拠", extractBumpReason],
    ["## 更新履歴（生成された利用者向け文言）", extractBumpChangelog],
    ["## 使い方（生成された利用者向け文言）", extractBumpUsage],
  ])("%s をワークフローが出力し、対応する関数が抜き出せる", (heading, extract) => {
    expect(workflow).toContain(`echo "${heading}"`);
    expect(extract(`${heading}\n\n本文\n\n## 対象issue\n- #1 foo`)).toBe("本文");
  });

  it("使い方は環境変数RELEASE_USAGEとして version lifecycleスクリプトへも渡る", () => {
    // env: と export の両方に無いと、bump-commandを使うリポジトリでだけ空文字になる（#1181と同じ罠）
    expect(workflow).toContain("RELEASE_USAGE: ${{ steps.bump.outputs.usage }}");
    expect(workflow).toContain("export NEW_VERSION BUMP_KIND RELEASE_CHANGELOG RELEASE_USAGE");
  });
});
