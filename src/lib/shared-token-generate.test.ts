import { describe, expect, it } from "vitest";

import { generateSharedTokenValue } from "./shared-token-generate";

describe("generateSharedTokenValue", () => {
  it("URLセーフな43文字の値を返す", () => {
    expect(generateSharedTokenValue()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("呼ぶたびに異なる値を返す", () => {
    expect(generateSharedTokenValue()).not.toBe(generateSharedTokenValue());
  });
});
