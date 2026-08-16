import { describe, expect, it } from "vitest";

import { canProceedFromInput, resolveInitialQuickStep } from "@/lib/quick-issue";

describe("resolveInitialQuickStep", () => {
  it("何も渡されていなければ入力ステップから始める", () => {
    expect(resolveInitialQuickStep({})).toBe("input");
    expect(resolveInitialQuickStep({ defaultTitle: null, defaultBody: null })).toBe("input");
    expect(resolveInitialQuickStep({ defaultTitle: "", defaultBody: "" })).toBe("input");
  });

  it("タイトル・本文のどちらかが渡されていれば確認ステップから始める", () => {
    expect(resolveInitialQuickStep({ defaultTitle: "引き継ぎ: #123" })).toBe("confirm");
    expect(resolveInitialQuickStep({ defaultBody: "元のコメント" })).toBe("confirm");
  });
});

describe("canProceedFromInput", () => {
  it("本文が空白だけなら進めない", () => {
    expect(canProceedFromInput("")).toBe(false);
    expect(canProceedFromInput("   \n ")).toBe(false);
  });

  it("本文があれば進める", () => {
    expect(canProceedFromInput("PWAで更新できない")).toBe(true);
  });
});
