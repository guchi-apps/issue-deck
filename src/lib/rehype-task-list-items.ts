/**
 * タスクリスト（`- [ ]`）のチェックボックスに、元のMarkdownでの行番号を持たせる（#1486）。
 *
 * 画面でチェックをクリックしたとき、書き換えるべきIssue本文の行を特定するために使う。
 * 「何番目のチェックボックスか」で数えるとレンダラとパーサで数え方を二重に持つことになり、
 * コードブロック中の例示や引用の扱いでずれる。**ASTが知っている実際の行番号**をそのまま渡す。
 *
 * `MarkdownBody`では`rehypeSanitize`の**後**に置く。`hast-util-sanitize`は`position`を保つので
 * 行番号は取れるうえ、sanitize後に付けるのでスキーマへ属性の許可を足す必要が無い。
 * 付与する値は数値と真偽値だけで、本文由来の文字列は入れない。
 */

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { line?: number } };
};

type HastNode = ({ type: string } & Partial<HastElement>) & { children?: HastNode[] };

type HastRoot = { type: "root"; children: HastNode[] };

/** チェックボックスに付ける、元Markdownでの行番号（1始まり） */
export const TASK_LINE_ATTRIBUTE = "data-task-line";

/** タスク項目の`li`に付ける印。箇条書きのマーカーを消してGitHubと同じ見た目にするために使う */
export const TASK_ITEM_ATTRIBUTE = "data-task-item";

function isElement(node: HastNode, tagName: string): node is HastElement & HastNode {
  return node.type === "element" && node.tagName === tagName;
}

function isCheckbox(node: HastNode): boolean {
  return isElement(node, "input") && node.properties?.type === "checkbox";
}

/**
 * `li`の中（tightなリストは直下、looseなリストは`p`の下）にある最初のチェックボックス。
 *
 * **入れ子のリストへは降りない。** 降りると`- 親`の下に`- [ ] 子`がある形で、親の`li`が子の
 * チェックボックスを掴み、子の行番号を親の行番号で上書きしてしまう。
 */
function findCheckbox(node: HastNode): HastElement | null {
  for (const child of node.children ?? []) {
    if (isCheckbox(child)) return child as HastElement;
    if (isElement(child, "ul") || isElement(child, "ol")) continue;
    const nested = findCheckbox(child);
    if (nested) return nested;
  }
  return null;
}

function visit(node: HastNode | HastRoot) {
  for (const child of node.children ?? []) {
    if (isElement(child, "li")) {
      const line = child.position?.start?.line;
      const checkbox = findCheckbox(child);
      if (checkbox && typeof line === "number") {
        child.properties = { ...child.properties, [TASK_ITEM_ATTRIBUTE]: true };
        checkbox.properties = { ...checkbox.properties, [TASK_LINE_ATTRIBUTE]: line };
      }
    }
    visit(child);
  }
}

export function rehypeTaskListItems() {
  return (tree: HastRoot) => {
    visit(tree);
  };
}
