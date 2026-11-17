#!/usr/bin/env node
// 不適切なデザイン（AIっぽい既定の見た目）の静的検出（#5465）。
//
// 禁止パターンの正は共有知識の`standards/ui-design.md`（guchi-apps/docs#281）。ここはそれを
// Tailwindのクラス・JSX・CSSから機械的に拾うだけで、**警告のみ**。終了コードは常に0
// （`--strict`を付けたときだけ検出があれば1）。設計・除外の書き方は docs/ui-design-lint.md。
//
// 使い方:
//   node scripts/check-ui-design.mjs [--github|--json|--report] [--strict] [対象...]
//   対象の既定は src/ 。ファイルかディレクトリを渡せる。
//
// 除外: 検出した行、またはその直前の行に`design-ok: <理由>`を書く。理由が空なら除外にならない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".css", ".html"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

/** 色クラス（border-l-4 だけでは色付きかどうか分からないので、同じ行に色が要る） */
const COLOR_BORDER = new RegExp(
  String.raw`\bborder-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|accent|destructive|warning|success)\b`,
);

const EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u2705\u274C\u274E\u26A0\u23F3\u2753\u2757\u2B50\u2728\u26A1\u2B55\u2B1B\u2B1C\u231B\u2614\u2615\u267B\u26D4]/u;

export const RULES = [
  {
    id: "side-border",
    message: "カードの左端・右端だけの色付き帯。状態はドットか文字ラベルで示す",
    test: (line) => /\bborder-[lr]-(?:[2-8]|\[\d+px\])\b/.test(line) && COLOR_BORDER.test(line),
  },
  {
    id: "gradient",
    message: "グラデーション。単色にし、面の区別は明度差か細い枠で行う",
    // repeating-*-gradient は斜線・点線のパターン（グラフの塗り分け）で、装飾のグラデーションではないので見ない
    test: (line) => /\bbg-(?:gradient|linear|radial|conic)-|(?<!repeating-)(?:linear|radial|conic)-gradient\(/.test(line),
  },
  {
    id: "emoji-icon",
    message: "絵文字をアイコン代わりに使っている。文字だけにするか、アプリのアイコンセットを使う",
    // コメント行は見ない。✓ ✕ ★ → などのテキスト記号は含めず、絵文字として描かれるものだけを見る
    test: (line) => !/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line) && EMOJI.test(line),
  },
  {
    id: "heavy-shadow",
    message: "影で重要度を演出していないか。影はメニュー・ダイアログなど浮き上がる要素だけに使う",
    test: (line) => /\bshadow-(?:lg|xl|2xl)\b/.test(line),
  },
];

const EXCLUDE_RE = /design-ok:\s*(\S.*?)(?:\*\/|-->|\}\s*$|$)/;

function exclusionReason(line) {
  const m = EXCLUDE_RE.exec(line);
  return m ? m[1].trim() : null;
}

/** 1ファイルの本文から検出を返す。除外されたものは excluded: true で残す（件数の集計に使う） */
export function scanText(text, file = "<text>") {
  const lines = text.split(/\r?\n/);
  const findings = [];
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (!rule.test(line)) continue;
      const reason = exclusionReason(line) ?? (i > 0 ? exclusionReason(lines[i - 1]) : null);
      findings.push({
        file,
        line: i + 1,
        rule: rule.id,
        message: rule.message,
        excluded: reason !== null,
        reason,
        snippet: line.trim().slice(0, 120),
      });
    }
  });
  return findings;
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.[tj]sx?$/.test(entry.name)) yield full;
  }
}

export function scanPaths(targets, root = process.cwd()) {
  const findings = [];
  for (const t of targets) {
    for (const file of walk(path.resolve(root, t))) {
      findings.push(...scanText(fs.readFileSync(file, "utf8"), path.relative(root, file)));
    }
  }
  return findings;
}

function formatTable(findings) {
  const active = findings.filter((f) => !f.excluded);
  const out = active.map((f) => `warning  ${f.file}:${f.line}  ${f.rule}  ${f.message}`);
  out.push(`${active.length}件の警告（除外 ${findings.length - active.length}件）。このチェックはマージを止めません。`);
  return out.join("\n");
}

function formatGithub(findings) {
  return findings
    .filter((f) => !f.excluded)
    .map((f) => `::warning file=${f.file},line=${f.line},title=design:${f.rule}::${f.message}`)
    .join("\n");
}

export function formatReport(findings) {
  const active = findings.filter((f) => !f.excluded);
  const byRule = new Map();
  for (const f of active) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  const lines = ["## ルール別の件数", "", "| ルール | 件数 |", "|---|---|"];
  for (const rule of RULES) lines.push(`| ${rule.id} | ${byRule.get(rule.id) ?? 0} |`);
  lines.push(`| 除外済み（design-ok） | ${findings.length - active.length} |`, "");
  lines.push("## 一覧", "", "| ファイル:行 | ルール | 該当行 | 仕分け（装飾／意味あり） |", "|---|---|---|---|");
  for (const f of active) {
    lines.push(`| \`${f.file}:${f.line}\` | ${f.rule} | \`${f.snippet.replace(/\|/g, "\\|").replace(/`/g, "'")}\` | |`);
  }
  return lines.join("\n");
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const targets = argv.filter((a) => !a.startsWith("--"));
  const findings = scanPaths(targets.length ? targets : ["src"]);
  const text = flags.has("--json")
    ? JSON.stringify(findings, null, 2)
    : flags.has("--report")
      ? formatReport(findings)
      : flags.has("--github")
        ? formatGithub(findings)
        : formatTable(findings);
  if (text) console.log(text);
  if (flags.has("--strict") && findings.some((f) => !f.excluded)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
