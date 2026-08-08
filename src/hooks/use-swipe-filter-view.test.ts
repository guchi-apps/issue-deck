// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { TouchEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { useSwipeFilterView } from "@/hooks/use-swipe-filter-view";

const CONTAINER_WIDTH = 400;

function makeTouch(clientX: number, clientY: number, target: Element) {
  return {
    touches: [{ clientX, clientY }],
    target,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, width: CONTAINER_WIDTH }) as DOMRect,
    },
  } as unknown as TouchEvent<HTMLElement>;
}

function swipe(
  handlers: ReturnType<typeof useSwipeFilterView>,
  from: { x: number; y: number },
  to: { x: number; y: number },
  target: Element = document.createElement("div"),
) {
  handlers.onTouchStart(makeTouch(from.x, from.y, target));
  handlers.onTouchMove(makeTouch(to.x, to.y, target));
  handlers.onTouchEnd();
}

describe("useSwipeFilterView", () => {
  it("左スワイプ（80px超）はnextを開始位置によらず通知する", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    act(() => swipe(result.current, { x: 50, y: 0 }, { x: -40, y: 0 }));

    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith("next");
  });

  it("画面左端寄り（BACK_EDGE_RATIO領域）以外からの右スワイプはprevを通知する", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    // 400px幅の画面で開始位置x=300は左端から1/5(80px)より外側
    act(() => swipe(result.current, { x: 300, y: 0 }, { x: 400, y: 0 }));

    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith("prev");
  });

  it("画面左端寄り（BACK_EDGE_RATIO領域）から始まった右スワイプは通知しない（戻る操作に譲る）", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    // 400px幅の画面で開始位置x=40は左端から1/5(80px)より内側
    act(() => swipe(result.current, { x: 40, y: 0 }, { x: 140, y: 0 }));

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("閾値未満の移動では通知しない", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    act(() => swipe(result.current, { x: 200, y: 0 }, { x: 230, y: 0 }));

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("縦方向優位の移動では通知しない", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    act(() => swipe(result.current, { x: 200, y: 0 }, { x: 220, y: 300 }));

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("横スクロール可能な要素（タブ列）から始まったタッチは対象外にする", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeFilterView(onSwipe));

    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollWidth", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 400, configurable: true });
    const originalGetComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, ...rest) => {
      if (el === scroller) return { overflowX: "auto" } as CSSStyleDeclaration;
      return originalGetComputedStyle(el, ...rest);
    });

    act(() => swipe(result.current, { x: 200, y: 0 }, { x: -40, y: 0 }, scroller));

    expect(onSwipe).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
