import { describe, expect, it } from "vitest";

import {
  buildLocalSessionCommand,
  buildLocalSessionUrl,
  LOCAL_SESSION_URL_SCHEME,
  parseRepositoryFullName,
} from "@/lib/local-session";

describe("parseRepositoryFullName", () => {
  it("owner/repo形式を分解する", () => {
    expect(parseRepositoryFullName("guchi-apps/issue-deck")).toEqual({
      owner: "guchi-apps",
      repo: "issue-deck",
    });
  });

  it("ドット・アンダースコアを含むリポジトリ名も通す", () => {
    expect(parseRepositoryFullName("guchi_apps/my.app-2")).toEqual({
      owner: "guchi_apps",
      repo: "my.app-2",
    });
  });

  it.each([
    ["スラッシュが無い", "issue-deck"],
    ["スラッシュが多い", "guchi-apps/issue-deck/extra"],
    ["ownerが空", "/issue-deck"],
    ["repoが空", "guchi-apps/"],
  ])("%s場合はnullを返す", (_name, input) => {
    expect(parseRepositoryFullName(input)).toBeNull();
  });

  // 登録済みプロトコルは任意のWebページから叩けるため、ハンドラ側へ渡る前に
  // シェル・Windows Terminalの区切り文字を落とす（片側だけ緩めない）。
  it.each([
    ["セミコロン（wtのサブコマンド区切り）", "guchi-apps/issue-deck;calc"],
    ["空白", "guchi-apps/issue deck"],
    ["引用符", 'guchi-apps/issue"deck'],
    ["バッククォート", "guchi-apps/issue`deck"],
    ["ドル記号", "guchi-apps/$deck"],
    ["親ディレクトリ参照", "guchi-apps/.."],
    ["アンパサンド", "guchi-apps/issue&deck"],
  ])("%sを含む場合はnullを返す", (_name, input) => {
    expect(parseRepositoryFullName(input)).toBeNull();
  });
});

describe("buildLocalSessionUrl", () => {
  it("issuedeck://start/<owner>/<repo>/<番号> を組み立てる", () => {
    expect(buildLocalSessionUrl("guchi-apps/issue-deck", 1049)).toBe(
      "issuedeck://start/guchi-apps/issue-deck/1049",
    );
  });

  it("スキーム名は定数と一致する", () => {
    expect(buildLocalSessionUrl("guchi-apps/issue-deck", 1)).toContain(
      `${LOCAL_SESSION_URL_SCHEME}://`,
    );
  });

  it.each([
    ["0", 0],
    ["負数", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
  ])("Issue番号が%sならnullを返す", (_name, issueNumber) => {
    expect(buildLocalSessionUrl("guchi-apps/issue-deck", issueNumber)).toBeNull();
  });

  it("リポジトリ名が不正ならnullを返す", () => {
    expect(buildLocalSessionUrl("guchi-apps/issue deck", 1049)).toBeNull();
  });
});

describe("buildLocalSessionCommand", () => {
  it("URL経路と同じstart-local-session.shを同じ引数で呼ぶ", () => {
    expect(buildLocalSessionCommand("guchi-apps/issue-deck", 1049)).toBe(
      "~/.local/share/issue-deck/start-local-session.sh guchi-apps issue-deck 1049",
    );
  });

  it("不正な入力ではnullを返す", () => {
    expect(buildLocalSessionCommand("guchi-apps/issue;deck", 1049)).toBeNull();
    expect(buildLocalSessionCommand("guchi-apps/issue-deck", 0)).toBeNull();
  });
});
