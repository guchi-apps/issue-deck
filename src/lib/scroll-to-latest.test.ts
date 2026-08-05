import { describe, expect, it } from "vitest";

import { computeScrollTopToRevealTarget } from "@/lib/scroll-to-latest";

describe("computeScrollTopToRevealTarget", () => {
  it("対象がコンテナ下端より下にある場合、その分だけスクロール量を増やす", () => {
    expect(computeScrollTopToRevealTarget(0, 100, 500)).toBe(400);
  });

  it("対象の上端がすでにコンテナの上端と一致している場合、スクロール量は変わらない", () => {
    expect(computeScrollTopToRevealTarget(120, 100, 100)).toBe(120);
  });

  it("対象がコンテナの上端より上にある場合、スクロール量を減らす", () => {
    expect(computeScrollTopToRevealTarget(300, 100, 20)).toBe(220);
  });
});
