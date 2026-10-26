import { describe, expect, it } from "vitest";

import {
  isBranchViewMode,
  selectBranchViewRepositories,
  type BranchViewMode,
} from "@/lib/branch-view-visibility";

type Repo = { name: string; mode: BranchViewMode; active: boolean; unknown: boolean };

function select(repos: Repo[], showAll = false) {
  return selectBranchViewRepositories(repos, {
    modeOf: (repo) => repo.mode,
    hasActivity: (repo) => repo.active,
    isUnknown: (repo) => repo.unknown,
    showAll,
  });
}

const repo = (name: string, mode: BranchViewMode, active = false, unknown = false): Repo => ({
  name,
  mode,
  active,
  unknown,
});

describe("selectBranchViewRepositories（#5087）", () => {
  it("always は動きがなくても並べる", () => {
    expect(select([repo("a", "always")]).visible.map((r) => r.name)).toEqual(["a"]);
  });

  it("active は動きがあるときだけ並べる（状態遷移: 動きなし→あり→なし）", () => {
    expect(select([repo("a", "active", false)]).hidden).toHaveLength(1);
    expect(select([repo("a", "active", true)]).visible).toHaveLength(1);
    expect(select([repo("a", "active", false)]).visible).toHaveLength(0);
  });

  it("active でも、動きの有無を判断できない（失敗・読み込み中）ときは並べる", () => {
    expect(select([repo("a", "active", false, true)]).visible).toHaveLength(1);
  });

  it("never は動きがあっても並べない。unknown でも並べない", () => {
    const result = select([repo("a", "never", true, true)]);
    expect(result.visible).toHaveLength(0);
    expect(result.hidden).toHaveLength(1);
  });

  it("showAll は全件を並べ、元の順序を保つ", () => {
    const result = select([repo("a", "never"), repo("b", "always"), repo("c", "active")], true);
    expect(result.visible.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(result.hidden).toHaveLength(0);
  });

  it("対象が0件でも空の結果を返す", () => {
    expect(select([])).toEqual({ visible: [], hidden: [] });
  });
});

describe("isBranchViewMode", () => {
  it("3つのモードだけを受け付ける", () => {
    expect(isBranchViewMode("always")).toBe(true);
    expect(isBranchViewMode("active")).toBe(true);
    expect(isBranchViewMode("never")).toBe(true);
    expect(isBranchViewMode("hidden")).toBe(false);
    expect(isBranchViewMode(undefined)).toBe(false);
  });
});
