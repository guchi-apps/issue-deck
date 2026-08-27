// `scripts/lib/manual-step-fill.sh`が、手作業の`<…>`へ値をどう差し込むかを固定する（#2403）。
//
// ここは**画面から届いた値がコマンドの構造を変えられないことの唯一の担保**。単引用符で包む
// 規則を1文字でも崩すと、値に`;`や`$(…)`が入ったときにそれがコマンドとして走る。
//
// あわせて`src/lib/manual-step-command.ts`の`shellQuoteValue`・`fillManualStepPlaceholders`と
// **同じ結果になること**も見る。pollerは自分で差し込んだ結果とサーバーの`resolvedCommand`を
// 突き合わせて、一致しなければ実行しない作りなので、ずれると実行できなくなる（安全側に倒れる
// が、動かない）。同じ表をどちらへも通して、ずれた時点で落とす。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fillManualStepPlaceholders, shellQuoteValue } from "@/lib/manual-step-command";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * bash側の`fill_placeholders`を1回実行する。
 *
 * **入力は環境変数で渡す。** スクリプトの文字列へ埋め込むと、`$(whoami)`のような値が
 * `fill_placeholders`に届く前にbashへ展開されてしまい、確かめたいことと逆の結果になる
 * （実物はjqが組んだJSONを受け取るので、そこで展開されることはない）。
 */
function fillWithBash(template, values) {
  const script = [
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/manual-step-fill.sh"))}`,
    'fill_placeholders "$TEMPLATE" "$VALUES"',
  ].join("\n");
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, TEMPLATE: template, VALUES: JSON.stringify(values) },
  });
}

/** 差し込んだ結果を実際にbashへ渡して、何が1語として届いたかを見る */
function runWithBash(command) {
  return execFileSync("bash", ["-c", command], { encoding: "utf8" });
}

/** TS側とbash側の両方へ通す表。**片方だけを直せばここで落ちる** */
const CASES = [
  {
    name: "単純な値",
    template: "KEY=<控えたkey> node oauth.mjs",
    values: { "<控えたkey>": "abc123" },
    expected: "KEY='abc123' node oauth.mjs",
  },
  {
    name: "シェルのメタ文字を含む値",
    template: "KEY=<控えたkey> node oauth.mjs",
    values: { "<控えたkey>": "a; rm -rf ~" },
    expected: "KEY='a; rm -rf ~' node oauth.mjs",
  },
  {
    name: "コマンド置換に見える値",
    template: "printf %s <k>",
    values: { "<k>": "$(whoami)" },
    expected: "printf %s '$(whoami)'",
  },
  {
    name: "単引用符を含む値",
    template: "KEY=<k> node x.mjs",
    values: { "<k>": "a'b" },
    expected: "KEY='a'\\''b' node x.mjs",
  },
  {
    name: "同じ穴が2つ",
    template: "a=<k> b=<k>",
    values: { "<k>": "v" },
    expected: "a='v' b='v'",
  },
  {
    name: "値が届いていない穴は残す",
    template: "a=<k> b=<j>",
    values: { "<k>": "v" },
    expected: "a='v' b=<j>",
  },
  {
    name: "値が1件も無ければそのまま",
    template: "KEY=<k> node x.mjs",
    values: {},
    expected: "KEY=<k> node x.mjs",
  },
  {
    name: "全角の山括弧",
    template: "gh issue view ＜番号＞",
    values: { "＜番号＞": "2403" },
    expected: "gh issue view '2403'",
  },
  {
    name: "行頭が#の行は書き換えない",
    template: "# <k> の説明\na=<k>",
    values: { "<k>": "v" },
    expected: "# <k> の説明\na='v'",
  },
];

describe("fill_placeholders（scripts/lib/manual-step-fill.sh・#2403）", () => {
  for (const { name, template, values, expected } of CASES) {
    it(name, () => {
      expect(fillWithBash(template, values)).toBe(expected);
    });
  }

  // **これが崩れると、値がコマンドとして走る。** 実際にbashへ渡して確かめる
  it("値はリテラルの1語にしかならない", () => {
    const filled = fillWithBash("printf %s <k>", { "<k>": "x; echo PWNED" });
    expect(runWithBash(filled)).toBe("x; echo PWNED");
  });

  it("改行を含む値も1語のまま（コマンドが増えない）", () => {
    const filled = fillWithBash("printf %s <k>", { "<k>": "a\nb" });
    expect(runWithBash(filled)).toBe("a\nb");
  });
});

// pollerとissue-deckが独立に差し込み、突き合わせて一致しなければ実行しない（2枚目の壁）。
// **同じ入力から同じ結果が出ること**が、その突き合わせが機能する前提になる
describe("issue-deck側（fillManualStepPlaceholders）と結果が一致する", () => {
  for (const { name, template, values, expected } of CASES) {
    it(name, () => {
      expect(fillManualStepPlaceholders(template, values)).toBe(expected);
      expect(fillManualStepPlaceholders(template, values)).toBe(fillWithBash(template, values));
    });
  }

  it("引用の規則そのものも一致する", () => {
    for (const value of ["abc", "a; b", "$(whoami)", "a'b", "", "改行なし"]) {
      const filled = fillWithBash("x=<k>", { "<k>": value });
      // 値が空のときは差し込まない（未入力として扱う）ので、そこだけ形が違う
      expect(filled).toBe(value === "" ? "x=<k>" : `x=${shellQuoteValue(value)}`);
    }
  });
});
