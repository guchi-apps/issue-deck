import { describe, expect, it } from "vitest";

import {
  computeFirstUnreadCommentIndex,
  computeScrollToLatestTarget,
  computeScrollTopToRevealTarget,
  isAtScrollTarget,
} from "@/lib/scroll-to-latest";

describe("computeScrollTopToRevealTarget", () => {
  it("対象がコンテナ下端より下にある場合、その分だけスクロール量を増やす", () => {
    expect(computeScrollTopToRevealTarget(0, 100, 500)).toBe(400);
  });

  it("対象の上端がすでにコンテナの上端と一致している場合、スクロール量は変わらない", () => {
    expect(computeScrollTopToRevealTarget(120, 100, 100)).toBe(120);
  });

  it("対象がコンテナの上端より上にある場合、スクロール量を減らす", () => {
    expect(computeScrollTopToRevealTarget(300, 100, 20)).toBe(220);
  });
});

describe("computeFirstUnreadCommentIndex", () => {
  it("未読がある場合、既読件数をそのまま最初の未読コメントのインデックスとして返す", () => {
    expect(computeFirstUnreadCommentIndex(3, 5)).toBe(3);
  });

  it("既読件数が0の場合、先頭（0）を返す", () => {
    expect(computeFirstUnreadCommentIndex(0, 5)).toBe(0);
  });

  it("全件既読の場合、最後のコメントのインデックスを返す", () => {
    expect(computeFirstUnreadCommentIndex(5, 5)).toBe(4);
  });

  it("既読件数がコメント総数を超えている場合（削除等）も、最後のコメントのインデックスを返す", () => {
    expect(computeFirstUnreadCommentIndex(8, 5)).toBe(4);
  });

  it("コメントが1件も無い場合、0を返す", () => {
    expect(computeFirstUnreadCommentIndex(0, 0)).toBe(0);
  });
});

describe("computeScrollToLatestTarget", () => {
  it("対象コメント上端に未到達の場合、対象コメント上端へのscrollTopを返す", () => {
    const top = computeScrollToLatestTarget({
      containerScrollTop: 0,
      containerTop: 100,
      targetTop: 500,
      containerScrollHeight: 2000,
    });
    expect(top).toBe(400);
  });

  it("対象コメント上端に到達済み（誤差の範囲内）の場合、コンテナ最下部へのscrollTopを返す", () => {
    const top = computeScrollToLatestTarget({
      containerScrollTop: 400,
      containerTop: 100,
      targetTop: 100,
      containerScrollHeight: 2000,
    });
    expect(top).toBe(2000);
  });

  it("誤差の境界値（許容誤差ちょうど）では到達済みとみなす", () => {
    // targetTopがcontainerTopより4px下（＝あと4pxスクロールが必要な状態）を、
    // 許容誤差ちょうどの誤差として扱う
    const top = computeScrollToLatestTarget({
      containerScrollTop: 396,
      containerTop: 100,
      targetTop: 104,
      containerScrollHeight: 2000,
    });
    expect(top).toBe(2000);
  });

  it("誤差の境界値を1px超えると未到達とみなす", () => {
    const top = computeScrollToLatestTarget({
      containerScrollTop: 396,
      containerTop: 100,
      targetTop: 105,
      containerScrollHeight: 2000,
    });
    expect(top).toBe(401);
  });
});

describe("isAtScrollTarget", () => {
  it("対象コメント上端に未到達の場合、falseを返す", () => {
    expect(
      isAtScrollTarget({
        containerScrollTop: 0,
        containerTop: 100,
        targetTop: 500,
      }),
    ).toBe(false);
  });

  it("対象コメント上端に到達済み（誤差の範囲内）の場合、trueを返す", () => {
    expect(
      isAtScrollTarget({
        containerScrollTop: 400,
        containerTop: 100,
        targetTop: 100,
      }),
    ).toBe(true);
  });

  it("誤差の境界値（許容誤差ちょうど）ではtrueを返す", () => {
    expect(
      isAtScrollTarget({
        containerScrollTop: 396,
        containerTop: 100,
        targetTop: 104,
      }),
    ).toBe(true);
  });

  it("誤差の境界値を1px超えるとfalseを返す", () => {
    expect(
      isAtScrollTarget({
        containerScrollTop: 396,
        containerTop: 100,
        targetTop: 105,
      }),
    ).toBe(false);
  });
});
