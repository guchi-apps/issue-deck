import { describe, expect, it } from "vitest";

import { BUMP_KIND_CRITERIA, isBumpKind, nextVersion } from "@/lib/semver-bump";

describe("nextVersion", () => {
  it("上げ幅ごとに次のバージョンを返す", () => {
    expect(nextVersion("3.21.0", "patch")).toBe("3.21.1");
    expect(nextVersion("3.21.0", "minor")).toBe("3.22.0");
    expect(nextVersion("3.21.0", "major")).toBe("4.0.0");
  });

  it("minor・majorでは下位の桁を0へ戻す", () => {
    expect(nextVersion("3.21.4", "minor")).toBe("3.22.0");
    expect(nextVersion("3.21.4", "major")).toBe("4.0.0");
  });

  it("前置のvと前後の空白は許容する", () => {
    expect(nextVersion("v1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion(" 1.2.3 ", "patch")).toBe("1.2.4");
  });

  it("読めないバージョンではnullを返す（画面は目安を出さない）", () => {
    expect(nextVersion(null, "patch")).toBeNull();
    expect(nextVersion("", "patch")).toBeNull();
    expect(nextVersion("3.21", "patch")).toBeNull();
    expect(nextVersion("3.21.0-rc.1", "patch")).toBeNull();
  });
});

describe("isBumpKind", () => {
  it("workflowが受け取る3値だけを通す", () => {
    expect(isBumpKind("major")).toBe(true);
    expect(isBumpKind("minor")).toBe(true);
    expect(isBumpKind("patch")).toBe(true);
    expect(isBumpKind("auto")).toBe(false);
    expect(isBumpKind("")).toBe(false);
    expect(isBumpKind(undefined)).toBe(false);
    expect(isBumpKind(1)).toBe(false);
  });
});

describe("BUMP_KIND_CRITERIA", () => {
  it("3値すべてに基準の文面がある（画面の選択肢に添える）", () => {
    expect(Object.keys(BUMP_KIND_CRITERIA).sort()).toEqual(["major", "minor", "patch"]);
    Object.values(BUMP_KIND_CRITERIA).forEach((criteria) => expect(criteria.length).toBeGreaterThan(0));
  });
});
