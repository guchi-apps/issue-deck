import { describe, expect, it } from "vitest";

import {
  isScreenshotCapableRepository,
  resolveScreenshotRepositoryRejection,
  SCREENSHOT_CAPABLE_REPOSITORIES,
} from "@/lib/github/screenshot-support";

describe("SCREENSHOT_CAPABLE_REPOSITORIES（#1118）", () => {
  it("どのエントリにも、対応と判断した材料が書いてある", () => {
    for (const repo of SCREENSHOT_CAPABLE_REPOSITORIES) {
      expect(repo.fullName).toMatch(/^[^/]+\/[^/]+$/);
      expect(repo.basis.length).toBeGreaterThan(0);
    }
  });

  it("同じリポジトリを二重に載せていない", () => {
    const names = SCREENSHOT_CAPABLE_REPOSITORIES.map((repo) => repo.fullName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("isScreenshotCapableRepository（#1118）", () => {
  it("撮影の仕組みを持つリポジトリは対応", () => {
    expect(isScreenshotCapableRepository("guchi-apps/issue-deck")).toBe(true);
    expect(isScreenshotCapableRepository("guchi-apps/shopping-list")).toBe(true);
  });

  it("持たないリポジトリは非対応", () => {
    expect(isScreenshotCapableRepository("guchi-apps/dayspan")).toBe(false);
  });
});

describe("resolveScreenshotRepositoryRejection（#1118）", () => {
  it("対応しているリポジトリは塞がない", () => {
    expect(resolveScreenshotRepositoryRejection("guchi-apps/issue-deck")).toBeNull();
  });

  // 未登録は「まだ判定できていない」ではなく「撮る仕組みを置いていない」なので塞ぐ
  it("一覧に無いリポジトリは理由を返し、リポジトリ名を含む", () => {
    const reason = resolveScreenshotRepositoryRejection("guchi-apps/solitaire");
    expect(reason).toContain("guchi-apps/solitaire");
    expect(reason).toContain("無人実行");
  });

  it("リポジトリ名が分からないときは塞がない", () => {
    expect(resolveScreenshotRepositoryRejection(null)).toBeNull();
    expect(resolveScreenshotRepositoryRejection(undefined)).toBeNull();
    expect(resolveScreenshotRepositoryRejection("")).toBeNull();
  });
});
