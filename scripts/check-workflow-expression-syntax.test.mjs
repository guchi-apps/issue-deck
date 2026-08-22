// `scripts/check-workflow-expression-syntax.mjs` を、仮のワークフローを置いたディレクトリに
// 対して実行する（#2181）。
//
// **この検査の価値は「Invalid workflow file をdevelopへ入れない」ことにある。** 壊れた
// ワークフローはジョブが1つも作られないため、Actionsの画面にログが残らず、原因が読み取れない。
// #2181では `run:` のPythonに書いた `if "${{" in command:` が式として解釈され、4時間半で
// 54件の失敗runが積み上がった。落ちるべきときに落ちるかは、実際に走らせないと確かめられない。
//
// **もう一つの目的は誤検知を出さないこと。** ワークフローの解説コメントには `${{ }}` が
// 説明として何度も出てくる。それを落とすと、ワークフローを触るPRが全部赤くなる。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/check-workflow-expression-syntax.mjs");

// このファイル自身がリテラルの `${{` を持つとテストの対象と同じ壊れ方をしうるため、
// ワークフローを組み立てるときも連結して書く。
const EXPR_OPEN = "$" + "{{";

let dir;

/** 仮のワークフローを1つ置く */
function writeWorkflow(body) {
  writeFileSync(path.join(dir, "sample.yml"), body, "utf8");
}

/** 検査を走らせ、終了コードと出力を返す */
function run() {
  try {
    const stdout = execFileSync("node", [script, dir], { encoding: "utf8" });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workflow-expression-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-workflow-expression-syntax", () => {
  it("式として妥当なワークフローは通る", () => {
    writeWorkflow(
      [
        "name: Sample",
        "on:",
        "  push:",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        `    if: ${EXPR_OPEN} github.event_name == 'push' && !cancelled() }}`,
        "    steps:",
        "      - name: Run",
        "        env:",
        `          TAG: ${EXPR_OPEN} inputs.version-file }}`,
        `          LIST: ${EXPR_OPEN} join(fromJSON(needs.a.outputs.items), ',') }}`,
        `          URL: ${EXPR_OPEN} format('{0}/{1}', github.server_url, github.repository) }}`,
        `          KEY: ${EXPR_OPEN} secrets['MY_KEY'] || '' }}`,
        "        run: |",
        `          echo "${EXPR_OPEN} steps.state.outputs.branch }}"`,
        "",
      ].join("\n"),
    );

    const result = run();
    expect(result.output).toContain("OK:");
    expect(result.code).toBe(0);
  });

  it("run: の中へリテラルで書いた式（#2181の壊れ方）を落とす", () => {
    writeWorkflow(
      [
        "name: Sample",
        "on:",
        "  push:",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Run",
        "        run: |",
        `          # GitHubの式 \`${EXPR_OPEN} ... }}\` は名前に \`{\` を含まない`,
        "          echo ok",
        "",
      ].join("\n"),
    );

    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sample.yml:10");
    expect(result.output).toContain("Invalid workflow file");
  });

  it("閉じていない式を落とす", () => {
    writeWorkflow(
      [
        "name: Sample",
        "on:",
        "  push:",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Run",
        "        run: |",
        `          python3 -c 'print("${EXPR_OPEN}" in text)'`,
        "",
      ].join("\n"),
    );

    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("対応する `}}` がありません");
  });

  it("run: の外のYAMLコメントに書いた式は誤検知しない", () => {
    writeWorkflow(
      [
        "name: Sample",
        "on:",
        "  push:",
        "jobs:",
        "  build:",
        `    # \`${EXPR_OPEN} }}\` を含む文字列ブロックには21,000バイトの上限がある（#901）`,
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Run",
        "        run: echo ok",
        "",
      ].join("\n"),
    );

    const result = run();
    expect(result.output).toContain("OK:");
    expect(result.code).toBe(0);
  });

  it("実際の .github/workflows が通る", () => {
    const stdout = execFileSync("node", [script, path.join(repoRoot, ".github/workflows")], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    expect(stdout).toContain("OK:");
  });
});
