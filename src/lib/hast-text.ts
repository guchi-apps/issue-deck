/**
 * hastのノードから、そこに含まれる文字列だけを取り出す（#1726）。
 *
 * `react-markdown`のカスタムコンポーネントが受け取る`children`はReact要素なので、そのままでは
 * 「このコードブロックの中身」を文字列として扱えない。一方で`node`にはパース結果のhastが
 * そのまま入っているため、テキストノードを深さ優先で連結すれば元の中身が戻る。
 *
 * `rehype-task-list-items.ts`と同じく、型は構造的な最小限の定義を自前で持つ（`@types/hast`は
 * 直接の依存ではなく、`react-markdown`経由で入っているだけのため）。
 */

type HastNode = {
  type: string;
  value?: unknown;
  children?: HastNode[];
};

export function hastToText(node: HastNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(hastToText).join("");
}

/**
 * コードブロックの中身をコピー用の文字列にする。
 *
 * フェンス付きコードブロックのテキストは必ず改行で終わる（`remark`がそう作る）。そのまま
 * コピーすると貼り付けた時点でコマンドが実行されてしまうので、末尾の改行1つだけを落とす。
 */
export function hastToCopyText(node: HastNode | null | undefined): string {
  return hastToText(node).replace(/\n$/, "");
}
