/**
 * Markdownのタスクリスト（`- [ ]` / `- [x]`）を数える・トグルする（#1486）。
 *
 * 手作業Issue（`71.manual-step`）の「やること」を1手順＝1チェック項目で書き、
 * issue-deckの画面から消し込めるようにするための土台。**チェックの実体はIssue本文そのもの**で、
 * トグルすると本文を`PATCH /api/issues`で書き換える。GitHub側の表示・進捗集計とも自動的に揃う。
 *
 * 行の特定にこのファイルの正規表現を使うのは`countTaskListItems`だけで、`toggleTaskListLine`が
 * 受け取る行番号は**レンダリング側のAST（`rehypeTaskListItems`）が付けた実際の行**である。
 * 数え方をパーサとレンダラで二重に持たないための分担で、ネストや引用の中にあるタスクでも
 * クリックした項目そのものが書き換わる。
 */

/** 行頭のリストマーカー（`-`・`*`・`+`・`1.`・`1)`）に続くチェックボックス */
const TASK_LINE_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s|$)/;

/** ```・~~~ で始まるコードフェンス。囲まれた中のタスク風の行は数えない */
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

export type TaskListCount = {
  /** タスク項目の総数 */
  total: number;
  /** うちチェック済みの数 */
  completed: number;
};

/**
 * 本文中のタスク項目を数える。進捗（「3件中2件完了」）の表示に使う。
 *
 * コードフェンスの中は数えない（テンプレートの例示をタスクとして数えないため）。
 * 4スペースのインデントコードブロックまでは見ておらず、そこにタスク風の行があると
 * 数に入る。手作業Issueのテンプレートはフェンス付きコードブロックで書くため実害は無い。
 */
export function countTaskListItems(markdown: string): TaskListCount {
  let total = 0;
  let completed = 0;
  let openFence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1];
      if (openFence === null) {
        openFence = marker[0];
        continue;
      }
      // 開いたときと同じ記号なら閉じる（```の中の~~~で閉じてしまわないように）
      if (marker[0] === openFence) openFence = null;
      continue;
    }
    if (openFence !== null) continue;

    const task = TASK_LINE_PATTERN.exec(line);
    if (!task) continue;
    total += 1;
    if (task[2] !== " ") completed += 1;
  }

  return { total, completed };
}

/**
 * `line`行目（1始まり）のチェックボックスを`checked`の状態にした本文を返す。
 *
 * その行がタスク行でなければ**元の文字列をそのまま返す**。画面を開いてから本文が別経路
 * （GitHub上での編集・エージェントの追記）で書き換わっていた場合に、無関係な行を壊さないため。
 * 呼び出し側は戻り値が元と同じなら送信を諦めてよい。
 */
export function toggleTaskListLine(markdown: string, line: number, checked: boolean): string {
  const lines = markdown.split("\n");
  const index = line - 1;
  if (index < 0 || index >= lines.length) return markdown;

  const match = TASK_LINE_PATTERN.exec(lines[index]);
  if (!match) return markdown;

  const [matched, prefix, , trailing] = match;
  const rest = lines[index].slice(matched.length);
  lines[index] = `${prefix}[${checked ? "x" : " "}]${trailing}${rest}`;
  return lines.join("\n");
}
