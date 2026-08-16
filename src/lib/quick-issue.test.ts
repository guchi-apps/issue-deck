import { describe, expect, it } from "vitest";

import {
  buildRepositoryChoices,
  canProceedFromInput,
  resolveInitialQuickStep,
} from "@/lib/quick-issue";

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

describe("buildRepositoryChoices", () => {
  it("選択中のリポジトリを先頭に置き、推定候補を続ける", () => {
    expect(
      buildRepositoryChoices("guchi-apps/shopping-list", [
        "guchi-apps/issue-deck",
        "guchi-apps/car-care",
      ]),
    ).toEqual(["guchi-apps/shopping-list", "guchi-apps/issue-deck", "guchi-apps/car-care"]);
  });

  it("選択中のリポジトリが候補にも含まれる場合は重複させない", () => {
    expect(
      buildRepositoryChoices("guchi-apps/issue-deck", [
        "guchi-apps/issue-deck",
        "guchi-apps/car-care",
      ]),
    ).toEqual(["guchi-apps/issue-deck", "guchi-apps/car-care"]);
  });

  it("上限を超えた候補は並べない", () => {
    expect(
      buildRepositoryChoices("guchi-apps/shopping-list", ["a/1", "a/2", "a/3", "a/4"]),
    ).toEqual(["guchi-apps/shopping-list", "a/1", "a/2"]);
  });

  it("選択中が空でも候補だけを並べる", () => {
    expect(buildRepositoryChoices("", ["a/1", "a/2"])).toEqual(["a/1", "a/2"]);
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
