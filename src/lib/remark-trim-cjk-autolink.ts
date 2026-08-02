type MdastText = { type: "text"; value: string };

type MdastLink = {
  type: "link";
  url: string;
  title?: string | null;
  children: MdastNode[];
};

type MdastNode = (MdastText | MdastLink | { type: string; children?: MdastNode[] }) & {
  children?: MdastNode[];
};

type MdastRoot = { type: "root"; children: MdastNode[] };

// remark-gfm（mdast-util-gfm-autolink-literal）がURL末尾の記号をトリムする際に使うのと同じ
// 正規表現・括弧バランス判定。非ASCII文字の位置でURLを打ち切った直後にも同じトリムを再適用し、
// 末尾の記号（句読点や閉じ括弧など）だけが誤ってURLに取り込まれたままにならないようにする。
const GFM_TRAILING_PUNCTUATION = /[!"&'),.:;<>?\]}]+$/;
const KNOWN_AUTOLINK_PREFIXES = ["", "http://", "mailto:"];

function countChar(value: string, char: string): number {
  let count = 0;
  for (const c of value) {
    if (c === char) count++;
  }
  return count;
}

function trimGfmTrailingPunctuation(value: string): [string, string] {
  const trailExec = GFM_TRAILING_PUNCTUATION.exec(value);
  if (!trailExec) return [value, ""];

  let url = value.slice(0, trailExec.index);
  let trail = trailExec[0];
  let closingParenIndex = trail.indexOf(")");
  const openingParens = countChar(url, "(");
  let closingParens = countChar(url, ")");

  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail.slice(0, closingParenIndex + 1);
    trail = trail.slice(closingParenIndex + 1);
    closingParenIndex = trail.indexOf(")");
    closingParens++;
  }

  return [url, trail];
}

function findNonAsciiIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return i;
  }
  return -1;
}

function isLiteralAutolink(node: MdastLink): node is MdastLink & { children: [MdastText] } {
  if (node.children.length !== 1) return false;
  const [child] = node.children;
  if (child.type !== "text") return false;
  const text = (child as MdastText).value;
  if (text.length === 0 || node.url.length < text.length) return false;
  const prefix = node.url.slice(0, node.url.length - text.length);
  if (!KNOWN_AUTOLINK_PREFIXES.includes(prefix)) return false;
  return node.url.slice(prefix.length) === text;
}

function trimNonAsciiAutolink(node: MdastLink & { children: [MdastText] }): MdastNode[] {
  const text = node.children[0].value;
  const cutIndex = findNonAsciiIndex(text);
  if (cutIndex === -1) return [node];

  const prefixLength = node.url.length - text.length;
  const asciiPart = text.slice(0, cutIndex);
  const rest = text.slice(cutIndex);
  const [trimmedText, trail] = trimGfmTrailingPunctuation(asciiPart);

  // プロトコル部分しか残らなかった（ドメインが丸ごと非ASCIIだった等）場合は、
  // 壊れたリンクを作らずオートリンク自体を諦めて元のテキストに戻す。
  const domainPart = trimmedText.replace(/^(https?:\/\/|mailto:)/i, "");
  if (!/[a-z0-9]/i.test(domainPart)) {
    return [{ type: "text", value: text }];
  }

  const newLink: MdastLink = {
    ...node,
    url: node.url.slice(0, prefixLength) + trimmedText,
    children: [{ type: "text", value: trimmedText }],
  };
  const remainder = trail + rest;
  return remainder.length === 0 ? [newLink] : [newLink, { type: "text", value: remainder }];
}

function visit(node: MdastNode | MdastRoot) {
  if (!node.children) return;
  const nextChildren: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "link" && isLiteralAutolink(child as MdastLink)) {
      nextChildren.push(...trimNonAsciiAutolink(child as MdastLink & { children: [MdastText] }));
      continue;
    }
    if (child.children) {
      visit(child);
    }
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkTrimCjkAutolink() {
  return (tree: MdastRoot) => {
    visit(tree);
  };
}
