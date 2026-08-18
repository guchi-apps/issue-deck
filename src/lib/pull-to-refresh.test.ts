import { describe, expect, it } from "vitest";

import {
  MIN_REFRESHING_MS,
  PULL_MAX_PX,
  PULL_THRESHOLD_PX,
  remainingRefreshingMs,
  resolvePullArrowDegrees,
  resolvePullDistance,
  resolvePullLabel,
  resolvePullPhase,
} from "@/lib/pull-to-refresh";

describe("resolvePullDistance", () => {
  it("指の移動量の半分だけ追従する", () => {
    expect(resolvePullDistance(100)).toBe(50);
  });

  it("上限で頭打ちにする", () => {
    expect(resolvePullDistance(1000)).toBe(PULL_MAX_PX);
  });

  it("上向き（負）は追従しない。通常のスクロールとして扱う分のため", () => {
    expect(resolvePullDistance(-120)).toBe(0);
    expect(resolvePullDistance(0)).toBe(0);
  });
});

describe("resolvePullPhase", () => {
  it("引いていない間はidle", () => {
    expect(resolvePullPhase(0, false)).toBe("idle");
  });

  it("しきい値未満はpull、到達するとready", () => {
    expect(resolvePullPhase(PULL_THRESHOLD_PX - 1, false)).toBe("pull");
    expect(resolvePullPhase(PULL_THRESHOLD_PX, false)).toBe("ready");
  });

  it("更新中は引っ張り量によらずrefreshing", () => {
    expect(resolvePullPhase(0, true)).toBe("refreshing");
    expect(resolvePullPhase(PULL_MAX_PX, true)).toBe("refreshing");
  });
});

describe("resolvePullLabel", () => {
  it("段階ごとに、いま何が起きるのかを出す", () => {
    expect(resolvePullLabel("idle")).toBeNull();
    expect(resolvePullLabel("pull")).toBe("引っ張って更新");
    expect(resolvePullLabel("ready")).toBe("離すと更新");
    expect(resolvePullLabel("refreshing")).toBe("更新中…");
  });
});

describe("resolvePullArrowDegrees", () => {
  it("しきい値でちょうど1周する", () => {
    expect(resolvePullArrowDegrees(0)).toBe(0);
    expect(resolvePullArrowDegrees(PULL_THRESHOLD_PX / 2)).toBe(180);
    expect(resolvePullArrowDegrees(PULL_THRESHOLD_PX)).toBe(360);
  });

  it("しきい値を超えても回り続けない", () => {
    expect(resolvePullArrowDegrees(PULL_MAX_PX)).toBe(360);
  });
});

describe("remainingRefreshingMs", () => {
  it("取得が速すぎたぶんだけ待たせる", () => {
    expect(remainingRefreshingMs(0)).toBe(MIN_REFRESHING_MS);
    expect(remainingRefreshingMs(200)).toBe(MIN_REFRESHING_MS - 200);
  });

  it("下限を超えていれば待たせない", () => {
    expect(remainingRefreshingMs(MIN_REFRESHING_MS + 100)).toBe(0);
  });
});
