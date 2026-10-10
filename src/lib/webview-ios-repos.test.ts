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

  it("yoteiflowもWebView型のiOSアプリを持つリポジトリとして返す", () => {
    const repo = getWebviewIosRepository("guchi-apps/yoteiflow");
    expect(repo?.appLabel).toBe("yoteiflow");
    expect(repo?.xcodeProjectPath).toBe("ios/YoteiFlow.xcodeproj");
    expect(repo?.command).toContain("cd ~/apps/yoteiflow");
    expect(repo?.command).toContain("open ios/YoteiFlow.xcodeproj");
  });

  it("aide・morrowもWebView型のiOSアプリを持つリポジトリとして返す", () => {
    const aide = getWebviewIosRepository("guchi-apps/aide");
    expect(aide?.xcodeProjectPath).toBe("ios/AIDEios.xcodeproj");
    expect(aide?.command).toContain("open ios/AIDEios.xcodeproj");
    const morrow = getWebviewIosRepository("guchi-apps/morrow");
    expect(morrow?.xcodeProjectPath).toBe("ios/Morrow.xcodeproj");
    expect(morrow?.command).toContain("cd ~/apps/morrow");
  });

  it("表に無いリポジトリはnull", () => {
    expect(getWebviewIosRepository("guchi-apps/vps")).toBeNull();
    expect(getWebviewIosRepository("guchi-apps/aide-ios")).toBeNull();
  });

  it("issue-deck自身も配布状態表示の対象として返す（#3846）", () => {
    const repo = getWebviewIosRepository("guchi-apps/issue-deck");
    expect(repo?.appLabel).toBe("issue-deck");
    expect(repo?.xcodeProjectPath).toBe("ios/IssueDeck.xcodeproj");
    expect(repo?.command).toContain("cd ~/apps/issue-deck");
    expect(repo?.command).toContain("open ios/IssueDeck.xcodeproj");
  });
});
