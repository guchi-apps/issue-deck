#!/usr/bin/env node
// プロンプト・ドキュメントの共有部分を1か所の正から配る（#1263・#2048）。
//
// 役割は2つある。
//
// 1. **手作業Issueの本文の雛形を、起票する側のプロンプトへ差し込む**（#2048）。正は
//    `docs/multi-agent/manual-step-body-template.md`。差し込み先はマーカー
//    （`<!-- manual-step-body-template:start -->`〜`:end`）で囲った区間。
// 2. **実装エージェント向けプロンプト（`scripts/prompts/*.md`）を、画面から使える
//    TypeScriptモジュールへ書き出す**（#1263）。画面（「実装プロンプトをコピー」）と
//    サブPCのランチャーが同じ文面を使うための変換。
//
// **正はMarkdown側**。内容の編集はMarkdownに対して行う。
//
// なぜ雛形を差し込むのか（#2048）。雛形のリテラルな骨組みは`docs/multi-agent/labels.md`に
// あったが、**実際に起票するエージェントが読むのはプロンプト側**で、そこには散文の要件
// リストしか無かった。そのため毎回モデルが要件から文面を再構成し、太字の有無・コードブロックの
// インデント・参照の書き方が揃わなかった（実測でopenな3件が3通り）。プロンプトを他リポジトリでも
// 使う以上、`labels.md`を読ませる形にはできない（そのリポジトリには存在しない）ため、
// 骨組みそのものをプロンプトへ埋め込む。
//
// 実行: node scripts/generate-prompt-templates.mjs
//       node scripts/generate-prompt-templates.mjs --check   # ずれていたら非ゼロで終わる（CI）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 書き出す対象。keyがTS側のexport名になる */
export const PROMPT_TEMPLATE_SOURCES = [
  { key: "GENERIC_IMPLEMENTATION_AGENT_TEMPLATE", path: "scripts/prompts/generic-implementation-agent.md" },
];

/** 手作業Issueの本文の雛形の正 */
export const MANUAL_STEP_BODY_TEMPLATE_SOURCE = "docs/multi-agent/manual-step-body-template.md";

/**
 * 雛形の差し込み先。
 *
 * **起票経路が3つある**（ローカル実行・汎用ランチャー・無人実行）ので、プロンプトは3つとも要る。
 * `labels.md`も差し込み先に含めるのは、規約の正である文書と雛形が食い違わないようにするため。
 */
export const MANUAL_STEP_BODY_TEMPLATE_TARGETS = [
  "docs/multi-agent/labels.md",
  "scripts/prompts/implementation-agent.md",
  "scripts/prompts/generic-implementation-agent.md",
  ".github/prompts/implement.md",
];

const MARKER_START = "<!-- manual-step-body-template:start -->";
const MARKER_END = "<!-- manual-step-body-template:end -->";

/**
 * マーカーで囲った区間を`template`で置き換える。
 *
 * マーカーが見つからない場合は**例外を投げる**。差し込み先からマーカーが消えたことに気付かず
 * 古い雛形が残るのが、この仕組みでいちばん起きてほしくない失敗のため。
 */
export function injectManualStepBodyTemplate(content, template) {
  const start = content.indexOf(MARKER_START);
  const end = content.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`マーカー（${MARKER_START} … ${MARKER_END}）が見つかりません`);
  }
  const head = content.slice(0, start);
  const tail = content.slice(end + MARKER_END.length);
  return `${head}${MARKER_START}\n${template.trim()}\n${MARKER_END}${tail}`;
}

function buildGeneratedTs() {
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

const GENERATED_TS = "src/lib/prompts/templates.generated.ts";

function main() {
  const check = process.argv.includes("--check");
  const stale = [];

  // 雛形の差し込みを先に済ませる。生成物（templates.generated.ts）は差し込み後の
  // generic-implementation-agent.md から作るため、順序を入れ替えると1回ぶん古くなる
  const template = readFileSync(join(ROOT, MANUAL_STEP_BODY_TEMPLATE_SOURCE), "utf8");
  for (const path of MANUAL_STEP_BODY_TEMPLATE_TARGETS) {
    const full = join(ROOT, path);
    const current = readFileSync(full, "utf8");
    const next = injectManualStepBodyTemplate(current, template);
    if (next === current) continue;
    if (check) {
      stale.push(path);
      continue;
    }
    writeFileSync(full, next);
    console.log(`updated ${path}`);
  }

  const generatedPath = join(ROOT, GENERATED_TS);
  const generated = buildGeneratedTs();
  if (readFileSync(generatedPath, "utf8") !== generated) {
    if (check) stale.push(GENERATED_TS);
    else {
      writeFileSync(generatedPath, generated);
      console.log(`generated ${GENERATED_TS}`);
    }
  }

  if (check && stale.length > 0) {
    console.error("次のファイルが正とずれています。`node scripts/generate-prompt-templates.mjs` を実行してください:");
    for (const path of stale) console.error(`  - ${path}`);
    process.exit(1);
  }
  if (check) console.log("プロンプトの共有部分は正と一致しています");
}

main();
