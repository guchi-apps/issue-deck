import { describe, expect, it } from "vitest";

import {
  buildLocalSessionCommand,
  buildLocalSessionUrl,
  isSupportedLocalSessionContract,
  LOCAL_SESSION_CONTRACT_VERSION,
  LOCAL_SESSION_URL_SCHEME,
  parseLocalSessionContractVersion,
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

describe("parseLocalSessionContractVersion", () => {
  it("冒頭のマーカー行から版数を読む", () => {
    const script = ["#!/usr/bin/env bash", "# issue-deck-local-session: v1", "set -euo pipefail"].join(
      "\n",
    );
    expect(parseLocalSessionContractVersion(script)).toBe(1);
  });

  it("マーカーが無ければnullを返す（＝ワンクリック起動に対応していない）", () => {
    expect(parseLocalSessionContractVersion("#!/usr/bin/env bash\nset -euo pipefail\n")).toBeNull();
  });

  it("行頭の`#`から始まらない記述はマーカーとして扱わない", () => {
    // 説明文の中でマーカーに言及しているだけの行を拾わないこと
    const script = 'echo "issue-deck-local-session: v1 を宣言してください"\n';
    expect(parseLocalSessionContractVersion(script)).toBeNull();
  });

  it("`#`とコロンの前後の空白を許容する", () => {
    expect(parseLocalSessionContractVersion("#   issue-deck-local-session:  v2  \n")).toBe(2);
  });
});

describe("isSupportedLocalSessionContract", () => {
  it("現在の版数を受け入れる", () => {
    expect(isSupportedLocalSessionContract(LOCAL_SESSION_CONTRACT_VERSION)).toBe(true);
  });

  it("issue-deck側より新しい版数は受け入れない（受け口を先に更新する必要がある）", () => {
    expect(isSupportedLocalSessionContract(LOCAL_SESSION_CONTRACT_VERSION + 1)).toBe(false);
  });

  it("宣言が無い場合は対応していないとみなす", () => {
    expect(isSupportedLocalSessionContract(null)).toBe(false);
  });
});
