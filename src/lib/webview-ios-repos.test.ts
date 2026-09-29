import { describe, expect, it } from "vitest";

import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

describe("getWebviewIosRepository", () => {
  it("旧名（myroom）でも新名（kurashio）と同じ内容を返す", () => {
    expect(getWebviewIosRepository("guchi-apps/myroom")).toBe(
      getWebviewIosRepository("guchi-apps/kurashio"),
    );
  });

  it("kurashioはWebView型のiOSアプリを持つリポジトリとして返す", () => {
    const repo = getWebviewIosRepository("guchi-apps/kurashio");
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
