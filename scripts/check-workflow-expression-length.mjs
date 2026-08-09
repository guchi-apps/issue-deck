#!/usr/bin/env node
// .github/workflows/ 配下のワークフローで、GitHub Actionsの式テンプレート長の上限
// （21,000バイト）に近づいている・超えている文字列を検出する。
//
// GitHub Actionsは `${{ }}` を1つでも含む文字列を、ブロック全体で1つの式テンプレートとして
// コンパイルする。その長さには21,000バイトの上限があり、超えるとワークフローファイル自体が
// 「Invalid workflow file」となり、issue_comment等のトリガーが**一切発火しなくなる**。
// pushのたびに失敗runが1件記録されるだけで、Issueへのコメント時にはrunすら作られないため、
// Actionsタブを見ていても気付きにくい（#901では丸半日、無人実装が停止していた）。
//
// 判定は展開後ではなく元テキストの長さで行われる。日本語は1文字3バイトのため、
// 見た目の文字数の3倍の速さで上限へ近づく点に注意（21,000バイト ≒ 日本語7,000文字）。
//
// 使い方: node scripts/check-workflow-expression-length.mjs
//   - 上限超過があれば exit 1
//   - 警告閾値（上限の85%）を超えたものがあれば一覧表示するが exit 0

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = ".github/workflows";
const MAX_BYTES = 21000;
const WARN_BYTES = Math.floor(MAX_BYTES * 0.85);

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/**
 * ブロックスカラー（`key: |` / `key: >`）の値を、YAMLと同じ規則でデデントして取り出す。
 * 完全なYAMLパーサではなく、ワークフローファイルで実際に使われる範囲に絞った行ベースの走査。
 * 依存パッケージを増やさずCIで動かすための割り切り。
 */
function collectScalars(source) {
  const lines = source.split("\n");
  const scalars = [];
  const blockStart = /^(\s*)(-\s+)?([\w.-]+):\s*[|>][-+]?\d*\s*(#.*)?$/;

  for (let i = 0; i < lines.length; i++) {
    const match = blockStart.exec(lines[i]);
    if (!match) {
      // 単一行の値。上限に届く長さになることはまずないが、念のため同じ基準で見る。
      if (lines[i].includes("${{")) {
        scalars.push({ line: i + 1, key: lines[i].trim().split(":")[0], value: lines[i] });
      }
      continue;
    }

    const keyIndent = match[1].length + (match[2] ? match[2].length : 0);
    const body = [];
    let j = i + 1;
    let contentIndent = null;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= keyIndent) break;
      if (contentIndent === null) contentIndent = indent;
      body.push(line.slice(contentIndent));
    }
    scalars.push({ line: i + 1, key: match[3], value: body.join("\n") });
    i = j - 1;
  }

  return scalars.filter((scalar) => scalar.value.includes("${{"));
}

const files = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const over = [];
const warned = [];

for (const file of files) {
  const path = join(WORKFLOW_DIR, file);
  for (const scalar of collectScalars(readFileSync(path, "utf8"))) {
    const bytes = byteLength(scalar.value);
    if (bytes > MAX_BYTES) over.push({ path, ...scalar, bytes });
    else if (bytes > WARN_BYTES) warned.push({ path, ...scalar, bytes });
  }
}

const format = (entry) =>
  `  ${entry.path}:${entry.line} (${entry.key}) — ${entry.bytes} バイト / 上限 ${MAX_BYTES}`;

if (warned.length > 0) {
  console.warn(`警告: 式テンプレート長が上限の85%（${WARN_BYTES}バイト）を超えています。`);
  for (const entry of warned) console.warn(format(entry));
  console.warn("  分量の大きい静的なセクションは env: へ切り出し、`${{ env.NAME }}` で参照してください。");
}

if (over.length > 0) {
  console.error(`エラー: 式テンプレート長が上限（${MAX_BYTES}バイト）を超えています。`);
  for (const entry of over) console.error(format(entry));
  console.error("  このままdevelopへマージすると、該当ワークフローのトリガーが一切発火しなくなります。");
  console.error("  分量の大きい静的なセクションは env: へ切り出し、`${{ env.NAME }}` で参照してください。");
  process.exit(1);
}

console.log(
  `OK: ${files.length}ファイル中、式テンプレート長が上限（${MAX_BYTES}バイト）を超えるものはありません。`,
);
