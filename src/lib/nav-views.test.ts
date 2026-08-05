import { describe, expect, it } from "vitest";

import { getNavViewDefaultState, resolveStateOnViewChange } from "@/lib/nav-views";

describe("getNavViewDefaultState", () => {
  it("状態を要求しないビューはopen、「main反映済(直近)」はall", () => {
    expect(getNavViewDefaultState("all")).toBe("open");
    expect(getNavViewDefaultState("favorites")).toBe("open");
    expect(getNavViewDefaultState("recently-merged")).toBe("all");
  });
});

describe("resolveStateOnViewChange", () => {
  it("状態を要求するビューへ切り替えると、明示的な選択より要求を優先する", () => {
    // Issue #475: リポジトリ画面でopen絞り込みのまま選ぶと必ず0件になっていた。
    expect(resolveStateOnViewChange("recently-merged", "all", "open", true)).toBe("all");
    expect(resolveStateOnViewChange("recently-merged", "favorites", "closed", true)).toBe("all");
    expect(resolveStateOnViewChange("recently-merged", "all", "open", false)).toBe("all");
  });

  it("状態を要求しないビューへの切り替えでは、明示的に選ばれた状態を引き継ぐ", () => {
    expect(resolveStateOnViewChange("favorites", "all", "closed", true)).toBe("closed");
    expect(resolveStateOnViewChange("check-user", "all", "all", true)).toBe("all");
  });

  it("明示的に選ばれていない状態は、切り替え先ビューの既定値に戻す", () => {
    // 「main反映済(直近)」で暗黙に適用されていたallを、お気に入りへ持ち込まない。
    expect(resolveStateOnViewChange("favorites", "recently-merged", "all", false)).toBe("open");
    expect(resolveStateOnViewChange("all", "recently-merged", "all", false)).toBe("open");
  });

  it("同じビューを選び直したときは、そのビューでの明示的な選択を上書きしない", () => {
    expect(resolveStateOnViewChange("recently-merged", "recently-merged", "open", true)).toBe(
      "open",
    );
    expect(resolveStateOnViewChange("favorites", "favorites", "closed", true)).toBe("closed");
  });
});
