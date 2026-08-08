import { describe, expect, it } from "vitest";

import { extractBumpChangelog, extractBumpReason } from "@/lib/github/release-bump-reason";

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
