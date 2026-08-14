#!/usr/bin/env node
// 実装エージェント向けプロンプトのテンプレート（scripts/prompts/*.md）を、画面から使える
// TypeScriptモジュールへ書き出す（#1263）。
//
// **正はMarkdown側**。画面（「実装プロンプトをコピー」）とサブPCのランチャーが同じ文面を使う
// ためだけの変換で、内容の編集はMarkdownに対して行う。ずれていないことは
// src/lib/prompts/templates.test.ts が検証する（本番ではこのスクリプトは走らないため、
// 生成物をコミットしておく必要がある）。
//
// 実行: node scripts/generate-prompt-templates.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 書き出す対象。keyがTS側のexport名になる */
export const PROMPT_TEMPLATE_SOURCES = [
  { key: "GENERIC_IMPLEMENTATION_AGENT_TEMPLATE", path: "scripts/prompts/generic-implementation-agent.md" },
];

function build() {
  const parts = PROMPT_TEMPLATE_SOURCES.map(({ key, path }) => {
    const body = readFileSync(join(ROOT, path), "utf8");
    // バッククォートと ${ をエスケープしてテンプレートリテラルへ埋める
    const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    return `/** ${path} の内容（自動生成） */\nexport const ${key} = \`${escaped}\`;\n`;
  });

  return [
    "// このファイルは scripts/generate-prompt-templates.mjs が生成しています。直接編集しないでください。",
    "// 内容を変えるときは scripts/prompts/*.md を編集し、`node scripts/generate-prompt-templates.mjs` を実行します。",
    "",
    ...parts,
  ].join("\n");
}

writeFileSync(join(ROOT, "src/lib/prompts/templates.generated.ts"), build());
console.log("generated src/lib/prompts/templates.generated.ts");
