import { describe, expect, it } from "vitest";

import { hastToCopyText, hastToText } from "@/lib/hast-text";

// `remark`がフェンス付きコードブロックから作るhastの形（pre > code > text）
function preNode(value: string) {
  return {
    type: "element",
    tagName: "pre",
    children: [
      { type: "element", tagName: "code", children: [{ type: "text", value }] },
    ],
  };
}

describe("hastToText", () => {
  it("入れ子のテキストノードを順につなげる", () => {
    expect(
      hastToText({
        type: "element",
        children: [
          { type: "text", value: "git " },
          { type: "element", children: [{ type: "text", value: "pull" }] },
        ],
      }),
    ).toBe("git pull");
  });

  it("ノードが無ければ空文字を返す", () => {
    expect(hastToText(undefined)).toBe("");
    expect(hastToText({ type: "element" })).toBe("");
  });
});

describe("hastToCopyText", () => {
  // フェンス付きコードブロックのテキストは必ず改行で終わる。そのまま貼ると実行されてしまう
  it("末尾の改行を1つだけ落とす", () => {
    expect(hastToCopyText(preNode("ssh vps\n"))).toBe("ssh vps");
    expect(hastToCopyText(preNode("ssh vps\n\n"))).toBe("ssh vps\n");
  });

  it("途中の改行は残す", () => {
    expect(hastToCopyText(preNode("cd ~/apps\npnpm install\n"))).toBe("cd ~/apps\npnpm install");
  });
});
