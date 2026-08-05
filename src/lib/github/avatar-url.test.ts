import { describe, expect, it } from "vitest";

import { githubAvatarUrl } from "@/lib/github/avatar-url";

describe("githubAvatarUrl", () => {
  it("GitHubのユーザー名からプロフィールアイコンのURLを組み立てる", () => {
    expect(githubAvatarUrl("m-guchi")).toBe("https://github.com/m-guchi.png?size=80");
  });
});
