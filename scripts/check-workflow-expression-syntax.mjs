#!/usr/bin/env node
// .github/workflows/ 配下のワークフローに書かれた `${{ ... }}` が、GitHub Actionsの式として
// 構文的に妥当かを検査する（#2181）。
//
// **GitHub Actionsは `run:` の中身も式テンプレートとして解釈する。** シェルスクリプトの
// コメントであっても、Pythonの文字列リテラルであっても関係ない。式として解釈できない
// `${{ ... }}` が1つでもあると、そのファイルは「Invalid workflow file」になり、
//   - pushのたびに、そのファイル名の失敗runが1件記録される
//   - そのワークフローのトリガーが一切発火しなくなる（再利用可能ワークフローなら、
//     呼び出し側のジョブがstartup failureで落ちる）
// という壊れ方をする。**ジョブが作られないためログが空で、原因が画面から読み取れない。**
// #2181では `deploy-config-check` のPythonに `if "${{" in command:` と書いたことで、
// 4時間半で54件の失敗runが積み上がり、main宛PRの version-tag-check が起動しなくなった。
//
// リテラルとして `${{` を書きたい場合は、文字列を連結して組み立てる（`"$" + "{{"`）か、
// YAMLレベルのコメント（`run:` の外）に置く。YAMLコメントはパーサに落とされるため、
// GitHubの式としては解釈されない。
//
// 使い方: node scripts/check-workflow-expression-syntax.mjs [ワークフローのディレクトリ]
//   - 式として解釈できない `${{ ... }}` があれば一覧を表示して exit 1
//   - ディレクトリは省略時 `.github/workflows`（テストから仮のワークフローを渡すために取る）

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = process.argv[2] ?? ".github/workflows";

/**
 * YAMLレベルのコメント行を空白へ均した本文を返す（文字位置は変えない）。
 *
 * ブロックスカラー（`run: |` など）の中の `#` は文字列の一部なのでGitHubが式として読む。
 * 一方、その外側の `#` から始まる行はYAMLパーサに落とされるため式にならない。この2つを
 * 区別しないと、既存のワークフローの解説コメントに書かれた `${{ }}` を誤検知する。
 */
function stripYamlComments(source) {
  const lines = source.split("\n");
  const blockStart = /^(\s*)(-\s+)?([\w.-]+):\s*[|>][-+]?\d*\s*(#.*)?$/;
  let blockIndent = null; // ブロックスカラーの中にいる間だけ、そのキーのインデント

  return lines
    .map((line) => {
      if (blockIndent !== null) {
        const indent = line.length - line.trimStart().length;
        if (line.trim() === "" || indent > blockIndent) return line; // まだ中にいる
        blockIndent = null;
      }
      const match = blockStart.exec(line);
      if (match) {
        blockIndent = match[1].length + (match[2] ? match[2].length : 0);
        return line;
      }
      // ブロックスカラーの外。行頭コメントだけを落とす（行中の `#` は文字列の一部でありうる）
      return line.trimStart().startsWith("#") ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

// --- GitHub Actionsの式のトークナイザ・パーサ -------------------------------
// 仕様: https://docs.github.com/actions/learn-github-actions/expressions
// 受け付ける範囲だけを実装する。**判定できない形は通す**（誤検知でCIを止める方が高くつく）。

const PUNCT = ["&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", ".", ",", "<", ">", "!", "*"];

class ExpressionError extends Error {}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new ExpressionError("文字列リテラルが閉じていません");
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2; // '' はエスケープされた '
            continue;
          }
          break;
        }
        j += 1;
      }
      tokens.push({ type: "string" });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(text[i + 1] ?? ""))) {
      const match = /^-?(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)/.exec(text.slice(i));
      if (!match) throw new ExpressionError(`数値として読めません: ${text.slice(i, i + 10)}`);
      tokens.push({ type: "number" });
      i += match[0].length;
      continue;
    }
    // 名前。プロパティ名にはハイフンを使える（`inputs.version-file` 等）
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
    if (name) {
      tokens.push({ type: "name", value: name[0] });
      i += name[0].length;
      continue;
    }
    const punct = PUNCT.find((p) => text.startsWith(p, i));
    if (punct) {
      tokens.push({ type: "punct", value: punct });
      i += punct.length;
      continue;
    }
    throw new ExpressionError(`式に使えない文字があります: ${JSON.stringify(c)}`);
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (value) => {
    const token = tokens[pos];
    if (token && token.type === "punct" && token.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };
  const expect = (value) => {
    if (!eat(value)) throw new ExpressionError(`${value} がありません`);
  };

  function primary() {
    const token = peek();
    if (!token) throw new ExpressionError("式が途中で終わっています");
    if (eat("(")) {
      const inner = or();
      expect(")");
      return inner;
    }
    if (eat("!")) return primary();
    if (eat("*")) return true; // `github.event.*.name` のような全指定
    pos += 1;
    if (token.type === "name" || token.type === "string" || token.type === "number") return true;
    throw new ExpressionError(`式の始まりとして読めません: ${token.value ?? token.type}`);
  }

  function postfix() {
    primary();
    for (;;) {
      if (eat(".")) {
        const token = peek();
        if (token && token.type === "punct" && token.value === "*") {
          pos += 1;
          continue;
        }
        if (!token || token.type !== "name") throw new ExpressionError("`.` の後にプロパティ名がありません");
        pos += 1;
        continue;
      }
      if (eat("[")) {
        or();
        expect("]");
        continue;
      }
      if (eat("(")) {
        if (!eat(")")) {
          do {
            or();
          } while (eat(","));
          expect(")");
        }
        continue;
      }
      return true;
    }
  }

  function unary() {
    while (eat("!"));
    return postfix();
  }

  function binary(next, operators) {
    next();
    for (;;) {
      const token = peek();
      if (token && token.type === "punct" && operators.includes(token.value)) {
        pos += 1;
        next();
        continue;
      }
      return true;
    }
  }

  const compare = () => binary(unary, ["<", "<=", ">", ">="]);
  const equality = () => binary(compare, ["==", "!="]);
  const and = () => binary(equality, ["&&"]);
  const or = () => binary(and, ["||"]);

  or();
  if (pos < tokens.length) {
    const token = tokens[pos];
    throw new ExpressionError(`式の後に余分なものがあります: ${token.value ?? token.type}`);
  }
}

/** `${{` から対応する `}}` までを探す。文字列リテラルの中の `}}` は終端とみなさない */
function findExpressionEnd(text, from) {
  let i = from;
  while (i < text.length) {
    if (text[i] === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          return text.startsWith("}}", i) ? i : findEndAfterQuote(text, i + 1);
        }
        i += 1;
      }
      return -1; // 閉じない文字列。式としても壊れているので未終端として扱う
    }
    if (text.startsWith("}}", i)) return i;
    i += 1;
  }
  return -1;
}

function findEndAfterQuote(text, from) {
  return findExpressionEnd(text, from);
}

const files = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const problems = [];
let checked = 0;

for (const file of files) {
  const path = join(WORKFLOW_DIR, file);
  const source = stripYamlComments(readFileSync(path, "utf8"));
  let index = source.indexOf("${{");
  while (index >= 0) {
    const line = source.slice(0, index).split("\n").length;
    const end = findExpressionEnd(source, index + 3);
    if (end < 0) {
      problems.push({
        path,
        line,
        message: "`${{` に対応する `}}` がありません",
        snippet: source.slice(index, index + 60).split("\n")[0],
      });
      break; // 以降は位置がずれるだけなので、このファイルはここで打ち切る
    }
    const body = source.slice(index + 3, end);
    checked += 1;
    try {
      parse(tokenize(body));
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      problems.push({ path, line, message: error.message, snippet: `\${{${body}}}`.split("\n")[0] });
    }
    index = source.indexOf("${{", end + 2);
  }
}

if (problems.length > 0) {
  console.error("エラー: GitHubの式として解釈できない `${{ ... }}` があります。");
  for (const problem of problems) {
    console.error(`  ${problem.path}:${problem.line} — ${problem.message}`);
    console.error(`    ${problem.snippet.trim().slice(0, 120)}`);
  }
  console.error("");
  console.error("  このままdevelopへマージすると該当ファイルが「Invalid workflow file」になり、");
  console.error("  pushのたびに失敗runが記録され、そのワークフローのトリガーが発火しなくなります。");
  console.error("  `${{` をリテラルとして書きたい場合は文字列を連結する（`\"$\" + \"{{\"`）か、");
  console.error("  `run:` の外のYAMLコメントへ書いてください。");
  process.exit(1);
}

console.log(`OK: ${files.length}ファイル中の${checked}件の式は、すべてGitHubの式として解釈できます。`);
