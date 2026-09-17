// `.github/workflows/reusable-release-develop-to-main.yml`の
// 「develop→mainのPRへ引き継ぐバージョンの判断根拠を取得する」ステップを、GitHub CLIのスタブに
// 対して実行する（#2978）。
//
// バンプPR（release/vX.Y.Z）本文の`## バージョンの判断根拠`は、CI通過後すぐ自動マージされて
// 閉じる。develop→mainのリリースPRを作る側で同じ節を引き継がないと、mainへマージするかを
// 人が判断する時点では理由を読めなくなる。`reusable-release-target-list.test.mjs`と同じやり方で
// YAMLから`run:`本文を取り出して実行する。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowYaml = readFileSync(
  path.join(repoRoot, ".github/workflows/reusable-release-develop-to-main.yml"),
  "utf8",
);

/** ステップ名から`run: |`の本文を取り出す（`reusable-release-target-list.test.mjs`と同じ実装） */
function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);

  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  if (runIndex < 0) throw new Error(`run: が見つかりません: ${stepName}`);

  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** `gh pr list`だけを返すスタブ。本文は`STUB_BUMP_BODY`をそのまま返す */
const STUB_GH = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  printf '%s' "\${STUB_BUMP_BODY:-}"
  exit 0
fi
exit 1
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "release-reason-"));
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runStep(bumpBody) {
  const script = extractRunScript("develop→mainのPRへ引き継ぐバージョンの判断根拠を取得する");
  const githubOutput = path.join(workDir, "github-output.txt");
  writeFileSync(githubOutput, "");

  const stdout = execFileSync("bash", ["-e", "-c", script], {
    cwd: workDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: githubOutput,
      GH_REPO: "guchi-apps/asset-manager",
      DEV_VERSION: "1.2.0",
      STUB_BUMP_BODY: bumpBody ?? "",
    },
  });

  const output = readFileSync(githubOutput, "utf8");
  const match = output.match(/^reason<<REASON_EOF\n([\s\S]*?)\nREASON_EOF$/m);
  return { stdout, reason: match ? match[1] : null };
}

describe("develop→mainのPRへ引き継ぐバージョンの判断根拠を取得する", () => {
  it("バンプPR本文から`## バージョンの判断根拠`の節（次の見出しまで）を取り出す", () => {
    const bumpBody = [
      "developへの取り込み待ちの変更を v1.2.0 としてリリースします。",
      "",
      "## バージョンの判断根拠",
      "コード差分の内容からminorバージョンと判定しました。",
      "",
      "新機能としてダークモードを追加しました。",
      "",
      "判断が誤っていると思われる場合は、このPR上でバージョンを修正してください。",
      "",
      "## 更新履歴（生成された利用者向け文言）",
      "",
      "ダークモードに対応しました。",
    ].join("\n");

    const { reason } = runStep(bumpBody);

    // bashのコマンド置換（`$(...)`）は末尾の改行をすべて落とすため、節の末尾の空行は残らない
    expect(reason).toBe(
      [
        "コード差分の内容からminorバージョンと判定しました。",
        "",
        "新機能としてダークモードを追加しました。",
        "",
        "判断が誤っていると思われる場合は、このPR上でバージョンを修正してください。",
      ].join("\n"),
    );
  });

  it("バンプPRが見つからない場合は空にする", () => {
    const { stdout, reason } = runStep("");

    expect(reason).toBe("");
    expect(stdout).toContain("引き継げなかった");
  });

  it("`## バージョンの判断根拠`の節が無い場合は空にする", () => {
    const bumpBody = ["developへの取り込み待ちの変更を v1.2.0 としてリリースします。", ""].join(
      "\n",
    );

    const { reason } = runStep(bumpBody);

    expect(reason).toBe("");
  });
});
