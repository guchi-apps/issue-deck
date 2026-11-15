import { describe, expect, it } from "vitest";

import { computeMobileHomeBadgeCount } from "@/lib/mobile-home-badge";

const attention = (actionRequired: number) => ({
  total: actionRequired + 2,
  autoMerging: 1,
  repairing: 1,
  actionRequired,
});

describe("computeMobileHomeBadgeCount（#5434）", () => {
  it("確認待ちタイルの数と、マージ待ちのうち人の操作が要るものを足す", () => {
    expect(computeMobileHomeBadgeCount(2, attention(3))).toBe(5);
  });

  it("自動マージ・自動修復中のマージ待ちは数えない", () => {
    // 要確認のタイルが全部0（マージ待ちは放っておけば入るものだけ）なら、バッジも0
    expect(computeMobileHomeBadgeCount(0, attention(0))).toBe(0);
  });

  it("PRが未取得なら確認待ちタイルの数だけを出す", () => {
    expect(computeMobileHomeBadgeCount(4, null)).toBe(4);
  });

  it("確認待ちの件数が無ければnull（バッジを出さない）", () => {
    expect(computeMobileHomeBadgeCount(null, attention(1))).toBeNull();
  });
});
