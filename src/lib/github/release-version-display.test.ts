import { describe, expect, it } from "vitest";

import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";

describe("formatMainVersionDisplay", () => {
  it("release_pr_open以外ではmainのバージョンのみを表示する", () => {
    expect(formatMainVersionDisplay("1.6.0", "1.7.0", "none")).toBe("v1.6.0");
    expect(formatMainVersionDisplay("1.6.0", "1.7.0", "bump_pr_open")).toBe("v1.6.0");
    expect(formatMainVersionDisplay("1.6.0", "1.7.0", "release_pending")).toBe("v1.6.0");
  });

  it("release_pr_open中はmain→developの矢印表示にする", () => {
    expect(formatMainVersionDisplay("1.6.0", "1.7.0", "release_pr_open")).toBe("v1.6.0→v1.7.0");
  });

  it("release_pr_open中でもdevelopVersionが取得できない場合は矢印を出さない", () => {
    expect(formatMainVersionDisplay("1.6.0", null, "release_pr_open")).toBe("v1.6.0");
  });

  it("release_pr_open中でもmainとdevelopが同じバージョンなら矢印を出さない", () => {
    expect(formatMainVersionDisplay("1.7.0", "1.7.0", "release_pr_open")).toBe("v1.7.0");
  });

  it("mainVersionが取得できない場合は - を返す", () => {
    expect(formatMainVersionDisplay(null, "1.7.0", "release_pr_open")).toBe("-");
  });
});

describe("formatDevelopVersionDisplay", () => {
  it("bump_pr_open以外ではdevelopのバージョンのみを表示する", () => {
    expect(formatDevelopVersionDisplay("1.6.0", "1.7.0", "none")).toBe("v1.6.0");
    expect(formatDevelopVersionDisplay("1.6.0", "1.7.0", "release_pending")).toBe("v1.6.0");
    expect(formatDevelopVersionDisplay("1.6.0", "1.7.0", "release_pr_open")).toBe("v1.6.0");
  });

  it("bump_pr_open中はdevelop→次バージョンの矢印表示にする", () => {
    expect(formatDevelopVersionDisplay("1.6.0", "1.7.0", "bump_pr_open")).toBe("v1.6.0→v1.7.0");
  });

  it("bump_pr_open中でも次バージョンが取得できない場合は矢印を出さない", () => {
    expect(formatDevelopVersionDisplay("1.6.0", null, "bump_pr_open")).toBe("v1.6.0");
  });

  it("bump_pr_open中でも次バージョンが現在と同じなら矢印を出さない", () => {
    expect(formatDevelopVersionDisplay("1.6.0", "1.6.0", "bump_pr_open")).toBe("v1.6.0");
  });

  it("developVersionが取得できない場合は - を返す", () => {
    expect(formatDevelopVersionDisplay(null, "1.7.0", "bump_pr_open")).toBe("-");
  });
});
