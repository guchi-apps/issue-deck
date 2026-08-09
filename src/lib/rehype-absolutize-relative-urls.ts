type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};

type HastNode = ({ type: string; children?: HastNode[] } | HastElement) & {
  children?: HastNode[];
};

type HastRoot = { type: "root"; children: HastNode[] };

const GITHUB_ORIGIN = "https://github.com";

/**
 * GitHub上ではブラウザのURL解決により `https://github.com` を起点に開けるroot-relative
 * （`/`始まり）なURLを、IssueDeckの自ドメインでも同じ場所を指すよう絶対URL化する。
 * `//`始まり（プロトコル相対）や `http(s)://`・`mailto:`・フラグメントのみ・空文字などは対象外。
 */
export function absolutizeGithubRootRelativeUrl(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  return `${GITHUB_ORIGIN}${url}`;
}

function visit(node: HastNode | HastRoot) {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === "element") {
      const element = child as HastElement;
      const properties = element.properties;
      if (properties) {
        if (element.tagName === "a" && typeof properties.href === "string") {
          properties.href = absolutizeGithubRootRelativeUrl(properties.href);
        }
        if (element.tagName === "img" && typeof properties.src === "string") {
          properties.src = absolutizeGithubRootRelativeUrl(properties.src);
        }
      }
      visit(element);
    }
  }
}

export function rehypeAbsolutizeRelativeUrls() {
  return (tree: HastRoot) => {
    visit(tree);
  };
}
