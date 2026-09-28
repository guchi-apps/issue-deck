import { describe, expect, it } from "vitest";

import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

describe("getWebviewIosRepository", () => {
  it("myroomはWebView型のiOSアプリを持つリポジトリとして返す", () => {
    const repo = getWebviewIosRepository("guchi-apps/myroom");
    expect(repo).not.toBeNull();
    expect(repo?.appLabel).toBe("kurashio");
    expect(repo?.xcodeProjectPath).toBe("ios/Kurashio.xcodeproj");
    expect(repo?.command).toContain("git switch develop");
    expect(repo?.command).toContain("open ios/Kurashio.xcodeproj");
  });

  it("表に無いリポジトリはnull", () => {
    expect(getWebviewIosRepository("guchi-apps/issue-deck")).toBeNull();
    expect(getWebviewIosRepository("guchi-apps/aide-ios")).toBeNull();
  });
});
