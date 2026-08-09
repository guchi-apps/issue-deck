import { describe, expect, it } from "vitest";
import { absolutizeGithubRootRelativeUrl } from "@/lib/rehype-absolutize-relative-urls";

describe("absolutizeGithubRootRelativeUrl", () => {
  it("root-relativeなURLにgithub.comを前置する", () => {
    expect(absolutizeGithubRootRelativeUrl("/owner/repo/blob/main/path")).toBe(
      "https://github.com/owner/repo/blob/main/path",
    );
    expect(absolutizeGithubRootRelativeUrl("/owner/repo/raw/main/image.png")).toBe(
      "https://github.com/owner/repo/raw/main/image.png",
    );
  });

  it("プロトコル相対URL(//始まり)は変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("//example.com/foo")).toBe("//example.com/foo");
  });

  it("絶対URL(http/https)は変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("https://example.com/foo")).toBe("https://example.com/foo");
    expect(absolutizeGithubRootRelativeUrl("http://example.com/foo")).toBe("http://example.com/foo");
  });

  it("mailto:は変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
  });

  it("フラグメントのみは変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("#section")).toBe("#section");
  });

  it("リーディング/を伴わない相対パスは変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("./foo.md")).toBe("./foo.md");
    expect(absolutizeGithubRootRelativeUrl("foo.md")).toBe("foo.md");
  });

  it("空文字は変更しない", () => {
    expect(absolutizeGithubRootRelativeUrl("")).toBe("");
  });
});
