import { describe, expect, it } from "vitest";

import {
  isPushKind,
  mutedWhere,
  notMutedWhere,
  PUSH_KIND_LABELS,
  PUSH_KINDS,
} from "@/lib/notifications/push-kinds";

describe("push-kinds", () => {
  it("全種類に表示名がある", () => {
    for (const kind of PUSH_KINDS) expect(PUSH_KIND_LABELS[kind].title).not.toBe("");
  });

  it("未知の種類は弾く", () => {
    expect(isPushKind("release")).toBe(true);
    expect(isPushKind("nope")).toBe(false);
    expect(isPushKind(1)).toBe(false);
  });

  it("OFFにしていないユーザーだけに絞る条件を作る", () => {
    expect(notMutedWhere("check-user")).toEqual({
      pushMutedKinds: { none: { kind: "check-user" } },
    });
    expect(mutedWhere("release")).toEqual({ pushMutedKinds: { some: { kind: "release" } } });
  });
});
