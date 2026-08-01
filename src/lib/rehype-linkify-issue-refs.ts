type HastText = { type: "text"; value: string };

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};

type HastNode = (HastText | HastElement | { type: string; children?: HastNode[] }) & {
  children?: HastNode[];
};

type HastRoot = { type: "root"; children: HastNode[] };

const ISSUE_REF_PATTERN = /(^|[^\w#])#(\d+)\b/g;
const SKIP_TAG_NAMES = new Set(["a", "code", "pre"]);

function buildIssueLink(repositoryFullName: string, number: string): HastElement {
  return {
    type: "element",
    tagName: "a",
    properties: {
      href: `https://github.com/${repositoryFullName}/issues/${number}`,
      target: "_blank",
      rel: "noreferrer",
    },
    children: [{ type: "text", value: `#${number}` }],
  };
}

function linkifyTextNode(node: HastText, repositoryFullName: string): HastNode[] {
  const { value } = node;
  const parts: HastNode[] = [];
  let lastIndex = 0;
  ISSUE_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ISSUE_REF_PATTERN.exec(value))) {
    const [, prefix, number] = match;
    const hashIndex = match.index + prefix.length;
    if (hashIndex > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, hashIndex) });
    }
    parts.push(buildIssueLink(repositoryFullName, number));
    lastIndex = hashIndex + 1 + number.length;
  }
  if (parts.length === 0) return [node];
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

function visit(node: HastNode | HastRoot, repositoryFullName: string) {
  if (!node.children) return;
  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      nextChildren.push(...linkifyTextNode(child as HastText, repositoryFullName));
      continue;
    }
    if (child.type === "element" && !SKIP_TAG_NAMES.has((child as HastElement).tagName)) {
      visit(child, repositoryFullName);
    }
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function rehypeLinkifyIssueRefs({ repositoryFullName }: { repositoryFullName?: string }) {
  return (tree: HastRoot) => {
    if (!repositoryFullName) return;
    visit(tree, repositoryFullName);
  };
}
