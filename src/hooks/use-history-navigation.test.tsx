// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHistoryNavigation } from "@/hooks/use-history-navigation";
import { canGoBackInApp, resetHistoryStack } from "@/lib/history-stack";

const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => currentSearchParams,
}));

const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});

function renderNavigation(query = "") {
  currentSearchParams = new URLSearchParams(query);
  return renderHook(() => useHistoryNavigation());
}

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  pushState.mockClear();
  replaceState.mockClear();
  resetHistoryStack();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useHistoryNavigation のURL更新（#1597）", () => {
  it("URLの更新にネイティブのHistory APIを使い、router経由の遷移（＝RSCの再取得）を起こさない", () => {
    const { result } = renderNavigation("view=all");

    act(() => result.current.navigateParams((params) => params.set("issue", "123"), { history: "push" }));

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0][2]).toBe("/dashboard?view=all&issue=123");
    // router.push を使うと /dashboard がサーバーで再実行され、その応答を待つまで
    // useSearchParams が更新されない（＝選択の反映が待たされる）
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("replaceは履歴を積まずにURLだけ差し替える", () => {
    const { result } = renderNavigation("view=all");

    act(() => result.current.navigateParams((params) => params.set("q", "deck"), { history: "replace" }));

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe("/dashboard?view=all&q=deck");
    expect(pushState).not.toHaveBeenCalled();
    expect(canGoBackInApp()).toBe(false);
  });

  it("pushしたぶんはアプリ内で巻き戻せる履歴として数える（#1396）", () => {
    const { result } = renderNavigation();

    act(() => result.current.navigateParams((params) => params.set("issue", "123"), { history: "push" }));

    expect(canGoBackInApp()).toBe(true);
  });

  it("結果が今のURLと同じなら何もしない（戻る操作が2回必要になるのを防ぐ）", () => {
    const { result } = renderNavigation("view=favorites");

    act(() =>
      result.current.navigateParams((params) => params.set("view", "favorites"), { history: "push" }),
    );

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(canGoBackInApp()).toBe(false);
  });

  it("クエリが空になったらパスだけのURLにする", () => {
    const { result } = renderNavigation("issue=123");

    act(() => result.current.navigateParams((params) => params.delete("issue"), { history: "replace" }));

    expect(replaceState.mock.calls[0][2]).toBe("/dashboard");
  });
});
