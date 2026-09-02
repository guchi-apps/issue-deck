/**
 * インラインコード（`` `apps` ``のように1行の中に書かれた`code`）へ印を付ける（#2753）。
 *
 * フェンス付きコードブロック（`` ``` ``）も同じ`code`要素として描かれる（`<pre><code>...`）ため、
 * 見分けずに扱うと`MarkdownBody`のコピー用チップがコードブロックの中にも二重に出てしまう。
 * ここでは**`pre`の中かどうか**だけを見て、`pre`の外にある`code`だけへ印を付ける。
 *
 * `rehype-task-list-items.ts`と同じ立て付け（`hast-util-sanitize`通過後の木を歩くだけの
 * 小さなプラグイン）。付ける値は真偽値のみで、本文由来の文字列は入れない。
 */

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type HastNode = ({ type: string } & Partial<HastElement>) & { children?: HastNode[] };

type HastRoot = { type: "root"; children: HastNode[] };

/** インラインコードの`code`要素に付ける印。`MarkdownBody`がコピー用チップに描き分ける */
export const INLINE_CODE_ATTRIBUTE = "data-inline-code";

function isElement(node: HastNode, tagName: string): node is HastElement & HastNode {
  return node.type === "element" && node.tagName === tagName;
}

function visit(node: HastNode | HastRoot, insidePre: boolean) {
  for (const child of node.children ?? []) {
    if (isElement(child, "code") && !insidePre) {
      child.properties = { ...child.properties, [INLINE_CODE_ATTRIBUTE]: true };
    }
    visit(child, insidePre || isElement(child, "pre"));
  }
}

export function rehypeMarkInlineCode() {
  return (tree: HastRoot) => {
    visit(tree, false);
  };
}
