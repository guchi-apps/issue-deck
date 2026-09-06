/**
 * シェルコマンドの文字列を、個別にコピー・実行できる単位へ分割する（#2818）。
 *
 * 手作業アシスタントの「手元で実行する」パネルや、質問パネルに埋め込まれるコマンドは、
 * 改行や`&&`で複数コマンドを繋いだ1本の文字列として渡ってくることがある。ここで分けるのは
 * **表示・コピーの単位だけ**で、実際に実行される文字列そのものは変えない（分割結果を実行へ
 * 流す経路は無い）。
 *
 * 引用符（`'...'`・`"..."`）の中の`&&`は分割しない。込み入った引用（バックスラッシュ
 * エスケープ・コマンド置換の中の`&&`等）までは扱わない——誤って分割しても「コピーする単位が
 * ずれる」だけで実害が無いため、迷ったら簡潔さへ倒す。
 */
export function splitShellCommandLines(command: string): string[] {
  const lines: string[] = [];
  for (const rawLine of command.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    lines.push(...splitTopLevelAnd(line));
  }
  return lines;
}

/** 引用符の外にある` && `だけで1行を分割する */
function splitTopLevelAnd(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && line[i + 1] === "&") {
      parts.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());

  return parts.filter((part) => part !== "");
}
