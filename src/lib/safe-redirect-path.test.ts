import { describe, expect, it } from "vitest";

import { toSafeRedirectPath } from "./safe-redirect-path";

describe("toSafeRedirectPath", () => {
  it("同一オリジン内のパスはそのまま返す", () => {
    expect(toSafeRedirectPath("/issues/new")).toBe("/issues/new");
    expect(toSafeRedirectPath("/github/setup?installation_id=1")).toBe("/github/setup?installation_id=1");
  });

  it.each(["@evil.example/x", ".evil.example", "//evil.example", "/\\evil.example", "https://evil.example", "evil"])(
    "%s は /dashboard へ倒す",
    (value) => {
      expect(toSafeRedirectPath(value)).toBe("/dashboard");
    },
  );

  it("未指定・空文字は /dashboard", () => {
    expect(toSafeRedirectPath(null)).toBe("/dashboard");
    expect(toSafeRedirectPath(undefined)).toBe("/dashboard");
    expect(toSafeRedirectPath("")).toBe("/dashboard");
  });
});
