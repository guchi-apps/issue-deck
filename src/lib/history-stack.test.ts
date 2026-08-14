import { beforeEach, describe, expect, it } from "vitest";

import {
  canGoBackInApp,
  recordHistoryPop,
  recordHistoryPush,
  resetHistoryStack,
} from "@/lib/history-stack";

describe("history-stack", () => {
  beforeEach(() => {
    resetHistoryStack();
  });

  it("何も積んでいなければ巻き戻せない（共有URLで直接開いた状態）", () => {
    expect(canGoBackInApp()).toBe(false);
  });

  it("画面遷移で積んだぶんだけ巻き戻せる", () => {
    recordHistoryPush();
    expect(canGoBackInApp()).toBe(true);

    recordHistoryPush();
    recordHistoryPop();
    expect(canGoBackInApp()).toBe(true);

    recordHistoryPop();
    expect(canGoBackInApp()).toBe(false);
  });

  it("積んだ数より多く戻ってもマイナスにならず、アプリ外へ出す判定にならない", () => {
    recordHistoryPush();
    recordHistoryPop();
    recordHistoryPop();
    recordHistoryPop();
    expect(canGoBackInApp()).toBe(false);

    // ここで1つ積めばすぐ巻き戻せる状態に戻る（過去のマイナス分が残らない）
    recordHistoryPush();
    expect(canGoBackInApp()).toBe(true);
  });
});
