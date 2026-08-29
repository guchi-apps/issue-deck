// `.github/workflows/reusable-claude-review-develop.yml`の「レビュー結果がPRに無ければ転記する」
// ステップを、GitHub CLIをスタブに差し替えて実行する（#2488）。
//
// **このステップは、レビュー結果がどこにも残らない状態を塞ぐための最後の砦。** 実際、
// `--allowedTools`に`gh pr comment`が無かったあいだ、レビューは走っているのに結果が
// 1件も残らず、PR本文の`## 検証結果`は`review=unavailable`、リリースPRの表は全行が
// 「記録なし」になっていた。**壊れても赤くならない**（`continue-on-error: true`）ため、
// 判定の分岐をここで直接実行して確かめる。

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-claude-review-develop.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

/** ステップ名から`run: |`の本文を取り出す（`reusable-issue-labels.test.mjs`と同じ最小実装） */
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

// `gh pr view --json comments --jq ...`は既存コメントの本文を、`gh pr comment --body-file`は
// 投稿内容をファイルへ書き出す（テストはそのファイルの有無と中身で判定する）。
const STUB_GH = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  printf '%s' "\${STUB_COMMENTS:-}"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "comment" ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cp "$2" "$STUB_POSTED"; fi
    shift
  done
  exit 0
fi
exit 0
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "review-report-"));
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** claude-code-actionが残す実行ログ（stream-jsonの配列）の最小形 */
function executionFile(texts) {
  return [
    { type: "system", subtype: "init" },
    ...texts.map((text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } })),
    { type: "result", subtype: "success", is_error: false },
  ];
}

/**
 * 転記ステップを走らせ、PRへ投稿された本文を返す（投稿しなかった場合はnull）。
 *
 * @param comments 既にPRに付いているコメントの本文（改行区切り）
 * @param execution 実行ログのJSON。nullならファイルごと無い状態にする
 */
function runTranscribe({ comments = "", execution = null, headSha = "abc123" } = {}) {
  const postedPath = path.join(workDir, "posted.md");
  const executionPath = path.join(workDir, "claude-execution-output.json");
  if (execution) writeFileSync(executionPath, JSON.stringify(execution));

  const script = extractRunScript("レビュー結果がPRに無ければ転記する");
  execFileSync("bash", ["-e", "-c", script], {
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      RUNNER_TEMP: workDir,
      GH_TOKEN: "dummy",
      GH_REPO: "guchi-apps/issue-deck",
      PR_NUMBER: "2490",
      HEAD_SHA: headSha,
      EXECUTION_FILE: executionPath,
      STUB_COMMENTS: comments,
      STUB_POSTED: postedPath,
    },
    encoding: "utf8",
  });

  return existsSync(postedPath) ? readFileSync(postedPath, "utf8") : null;
}

describe("レビュー結果がPRに無ければ転記する", () => {
  it("PRに結果が無ければ、実行ログの最後の応答を転記する", () => {
    const posted = runTranscribe({
      comments: "実装しました。\n自動修復のコメント",
      execution: executionFile(["差分を読みます", "## 総評\n\nLGTM。問題ありません。"]),
    });

    expect(posted).toContain("LGTM。問題ありません。");
    expect(posted).toContain("ワークフローが実行ログから転記しました");
    // リリースPRの集計（reusable-release-develop-to-main.yml）がこの印で拾う
    expect(posted).toContain("<!-- issue-deck-review-report sha=abc123 -->");
    // **判定は作らない。** 応答に無い`lgtm`等をこちらで書くと、していないレビューの判定になる
    expect(posted).not.toContain("issue-deck-review-verdict");
  });

  it("レビュー本体が今回のSHAで投稿済みなら、二重に投稿しない", () => {
    const posted = runTranscribe({
      comments: "## 総評\n\nLGTM。\n\n<!-- issue-deck-review-verdict:lgtm sha=abc123 -->",
      execution: executionFile(["## 総評\n\nLGTM。"]),
    });

    expect(posted).toBeNull();
  });

  it("前のpushで投稿された判定は、投稿済みとみなさない", () => {
    // 追いコミットのたびにレビューし直すため、`sha=`が違う判定は今回の結果ではない
    const posted = runTranscribe({
      comments: "<!-- issue-deck-review-verdict:lgtm sha=old999 -->",
      execution: executionFile(["## 総評\n\n要確認。"]),
    });

    expect(posted).toContain("要確認。");
  });

  it("実行ログから本文を取り出せなければ、何も投稿しない", () => {
    // スキーマが変わった場合（claude-code-actionの内部実装で、変わりうる）
    expect(runTranscribe({ execution: [{ type: "result" }] })).toBeNull();
    expect(runTranscribe({ execution: null })).toBeNull();
  });

  it("長い応答は打ち切る（PRコメントの上限を超えないため）", () => {
    const long = Array.from({ length: 600 }, (_, index) => `${index}行目`).join("\n");
    const posted = runTranscribe({ execution: executionFile([long]) });

    expect(posted).toContain("0行目");
    expect(posted).not.toContain("599行目");
    expect(posted).toContain("（長いため以降を省略しました。全文はActionsの実行ログにあります）");
  });
});
