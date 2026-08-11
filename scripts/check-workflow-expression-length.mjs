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
  console.error("  分量の大きい静的なセクションは .github/prompts/ へ切り出してください（#907）。");
  process.exit(1);
}

// .github/prompts/ 配下のプロンプトファイルのプレースホルダを検査する（#907）。
// ここで使えるのは組み立てステップが envsubst に明示指定している変数だけで、それ以外の
// `${FOO}` は置換されずそのままエージェントへ渡る。`${{ }}` を書いてもGitHub Actionsの式としては
// 評価されない（ワークフローYAMLの外にあるため）。どちらも実行時に静かに壊れるだけで
// 気付きにくいため、CIで落とす。
const PROMPT_DIR = ".github/prompts";

/**
 * 各プロンプトファイルで使えるプレースホルダを、ワークフロー側の
 * `envsubst '${A} ${B} ...' < "$PROMPT_FILE"` から自動導出する。
 *
 * プロンプトを持つワークフローは複数あり（claude-issue-dispatch / claude-ci-fix など、#1066）、
 * 使える変数はワークフローごとに異なる。ここを単一の固定リストにすると、あるワークフローで
 * 追加した変数が別のワークフローのプロンプトでも「既知」と判定され、実行時に空文字で
 * 置換される事故を検出できなくなる。導出元を1つにすることで、変数を増やすときに
 * このスクリプトを更新する必要も無くなる。
 *
 * 走査は行ベース。`PROMPT_FILE="${PROMPTS_DIR:-.github/prompts}/<名前>.md"` を見つけたら
 * 以降の `envsubst '...'` をそのファイルのものとみなす（実際のステップがこの順で書かれているため）。
 */
function collectPromptPlaceholders() {
  const map = new Map(); // "ci-fix.md" -> Set(["ISSUE_NUMBER", ...])
  for (const file of files) {
    const source = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    let current = null;
    for (const line of source.split("\n")) {
      const fileMatch = /\/([\w.-]+\.md)"/.exec(line);
      if (fileMatch) current = fileMatch[1];
      const envsubstMatch = /envsubst\s+'([^']*)'/.exec(line);
      if (!envsubstMatch || !current) continue;
      const names = [...envsubstMatch[1].matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
      const known = map.get(current) ?? new Set();
      for (const name of names) known.add(name);
      map.set(current, known);
    }
  }
  return map;
}

const promptProblems = [];
let promptFiles = [];
try {
  promptFiles = readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md")).sort();
} catch {
  promptFiles = []; // ディレクトリが無いリポジトリではこの検査自体をスキップする
}

const placeholdersByPrompt = collectPromptPlaceholders();

for (const file of promptFiles) {
  const path = join(PROMPT_DIR, file);
  const known = placeholdersByPrompt.get(file);
  if (!known) {
    // どのワークフローからも組み立てられないプロンプトは、消し忘れかファイル名の取り違え。
    promptProblems.push(
      `  ${path} — どのワークフローからも参照されていません（envsubstで組み立てるステップが見つかりません）`,
    );
    continue;
  }
  const source = readFileSync(path, "utf8");
  source.split("\n").forEach((line, index) => {
    if (line.includes("${{")) {
      promptProblems.push(`  ${path}:${index + 1} — \`\${{ }}\` は評価されません。\`\${VAR}\` 形式にしてください`);
    }
    for (const [, name] of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (!known.has(name)) {
        const usable = [...known].map((n) => "${" + n + "}").join(" ");
        promptProblems.push(
          `  ${path}:${index + 1} — 未知のプレースホルダ \`\${${name}}\`（空文字に置換されます）。このファイルで使えるのは ${usable}`,
        );
      }
    }
  });
}

if (promptProblems.length > 0) {
  console.error("エラー: プロンプトファイルのプレースホルダに問題があります。");
  for (const problem of promptProblems) console.error(problem);
  console.error("  変数を追加する場合は、そのプロンプトを組み立てるステップの env: と");
  console.error("  envsubst の変数リストの両方に追加してください（このスクリプトの更新は不要です）。");
  process.exit(1);
}

console.log(
  `OK: ${files.length}ファイル中、式テンプレート長が上限（${MAX_BYTES}バイト）を超えるものはありません。`,
);
console.log(`OK: ${PROMPT_DIR} の${promptFiles.length}ファイルのプレースホルダに問題はありません。`);
