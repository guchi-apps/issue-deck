import { describe, expect, it } from "vitest";

import {
  isSameParentRunChildMark,
  parentRunChildMarkText,
  resolveParentRunChildKind,
} from "@/lib/parent-run/child-state";

describe("resolveParentRunChildKind", () => {
  it("起動済みのphaseは実行中、未起動の待機は順番待ち、それ以外は印なし", () => {
    expect(resolveParentRunChildKind("running")).toBe("running");
    expect(resolveParentRunChildKind("launching")).toBe("running");
    expect(resolveParentRunChildKind("ready")).toBe("waiting");
    expect(resolveParentRunChildKind("waiting")).toBe("waiting");
    for (const phase of ["attention", "blocked", "done", "skipped"] as const) {
      expect(resolveParentRunChildKind(phase)).toBeNull();
    }
  });
});

describe("parentRunChildMarkText", () => {
  it("親の番号を添える", () => {
    expect(parentRunChildMarkText({ kind: "running", parentNumber: 100 })).toBe("親 #100 の自動実行中");
    expect(parentRunChildMarkText({ kind: "waiting", parentNumber: 100 })).toBe("親 #100 の順番待ち");
  });
});

describe("isSameParentRunChildMark", () => {
  const a = { kind: "waiting" as const, parentRepository: "o/r", parentNumber: 1, reason: "x" };
  it("内容が同じなら等しく、種類や理由が違えば異なる", () => {
    expect(isSameParentRunChildMark(null, null)).toBe(true);
    expect(isSameParentRunChildMark(a, { ...a })).toBe(true);
    expect(isSameParentRunChildMark(a, null)).toBe(false);
    expect(isSameParentRunChildMark(a, { ...a, kind: "running" })).toBe(false);
    expect(isSameParentRunChildMark(a, { ...a, reason: "y" })).toBe(false);
  });
});
