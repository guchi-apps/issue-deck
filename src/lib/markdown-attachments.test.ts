import { describe, expect, it } from "vitest";

import { appendToBody, splitAttachments } from "@/lib/markdown-attachments";

describe("appendToBody", () => {
  it("添付が無ければ本文の末尾へ空行を挟んで足す", () => {
    expect(appendToBody("本文\n", "追加")).toBe("本文\n\n追加");
  });

  it("画像記法の上へ足し、添付として読める形を保つ", () => {
    const value = "本文\n\n![a.png](/api/issues/images/x.png)";
    const next = appendToBody(value, "追加");

    expect(next).toBe("本文\n\n追加\n\n![a.png](/api/issues/images/x.png)");
    expect(splitAttachments(next).attachments).toEqual([{ name: "a.png", url: "/api/issues/images/x.png" }]);
  });

  it("本文が空なら足す文だけを本文にする", () => {
    expect(appendToBody("![a.png](u)", "追加")).toBe("追加\n\n![a.png](u)");
  });
});
