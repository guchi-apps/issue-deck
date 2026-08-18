// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import {
  MAX_EXTERNAL_REFRESHING_MS,
  MIN_REFRESHING_MS,
  PULL_MAX_PX,
  PULL_THRESHOLD_PX,
} from "@/lib/pull-to-refresh";

// jsdomには`TouchEvent`のコンストラクタが無いため、ハンドラが読む`touches`だけを持つ
// イベントを組み立てて実要素へdispatchする。フックはネイティブリスナーで受けるので、
// 偽のイベントオブジェクトをハンドラへ直接渡す形（use-swipe-filter-view.test.ts）は使えない。
function touchEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: [{ clientX: x, clientY: y }],
  });
  return event;
}

function setup(onRefresh?: () => Promise<unknown> | void, scrollTop = 0, isRefreshing = false) {
  const container = document.createElement("div");
  const list = document.createElement("ul");
  Object.defineProperty(list, "scrollTop", { value: scrollTop, writable: true });
  container.appendChild(list);
  document.body.appendChild(container);

  const containerRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  const scrollRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  containerRef.current = container;
  scrollRef.current = list;

  // 画面側の取得中フラグ（#1958）は途中で変わるため、rerenderで差し替えられる形で渡す
  const view = renderHook(
    (props: { isRefreshing: boolean }) =>
      usePullToRefresh({ containerRef, scrollRef, onRefresh, isRefreshing: props.isRefreshing }),
    { initialProps: { isRefreshing } },
  );
  return { container, list, view };
}

function drag(container: HTMLElement, points: Array<[number, number]>) {
  const [start, ...moves] = points;
  act(() => {
    container.dispatchEvent(touchEvent("touchstart", start[0], start[1]));
  });
  for (const [x, y] of moves) {
    act(() => {
      container.dispatchEvent(touchEvent("touchmove", x, y));
    });
  }
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("usePullToRefresh", () => {
  it("先頭から下へ引っ張るとしきい値で更新が走る", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container, view } = setup(onRefresh);

    drag(container, [
      [100, 100],
      [100, 140],
      [100, 300],
    ]);
    expect(view.result.current.distance).toBe(PULL_MAX_PX);
    expect(view.result.current.phase).toBe("ready");
    expect(view.result.current.label).toBe("離すと更新");

    await act(async () => {
      container.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(view.result.current.phase).toBe("refreshing");
  });

  it("しきい値に届かずに離すと更新しない", async () => {
    const onRefresh = vi.fn();
    const { container, view } = setup(onRefresh);

    drag(container, [
      [100, 100],
      [100, 120],
    ]);
    expect(view.result.current.phase).toBe("pull");
    expect(view.result.current.label).toBe("引っ張って更新");
    expect(view.result.current.distance).toBeLessThan(PULL_THRESHOLD_PX);

    await act(async () => {
      container.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(view.result.current.distance).toBe(0);
  });

  it("先頭にいないときは引っ張りを受け付けない", async () => {
    const onRefresh = vi.fn();
    const { container, view } = setup(onRefresh, 120);

    drag(container, [
      [100, 100],
      [100, 300],
    ]);
    expect(view.result.current.distance).toBe(0);

    await act(async () => {
      container.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("横方向のスワイプ（戻る・ビュー切り替え）には反応しない", async () => {
    const onRefresh = vi.fn();
    const { container, view } = setup(onRefresh);

    drag(container, [
      [100, 100],
      [300, 110],
    ]);
    expect(view.result.current.distance).toBe(0);

    await act(async () => {
      container.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("先頭から上へスワイプしたときは既定のスクロールを止めない", () => {
    const { container } = setup(vi.fn());

    act(() => {
      container.dispatchEvent(touchEvent("touchstart", 100, 300));
    });
    const move = touchEvent("touchmove", 100, 200);
    act(() => {
      container.dispatchEvent(move);
    });
    expect(move.defaultPrevented).toBe(false);
  });

  it("下へ引っ張っている間だけ既定の動作を止める", () => {
    const { container } = setup(vi.fn());

    act(() => {
      container.dispatchEvent(touchEvent("touchstart", 100, 100));
    });
    const move = touchEvent("touchmove", 100, 200);
    act(() => {
      container.dispatchEvent(move);
    });
    expect(move.defaultPrevented).toBe(true);
  });

  it("更新を渡さない一覧（PC）では何も起きない", () => {
    const { container, view } = setup(undefined);

    drag(container, [
      [100, 100],
      [100, 300],
    ]);
    expect(view.result.current.distance).toBe(0);
    expect(view.result.current.label).toBeNull();
  });

  // 画面の取得中フラグを渡した場合（#1958）
  describe("画面が取得中の間の扱い", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("下限を過ぎても、画面が取得中の間は「更新中…」を保つ", async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const { container, view } = setup(onRefresh, 0, true);

      drag(container, [
        [100, 100],
        [100, 300],
      ]);
      await act(async () => {
        container.dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MIN_REFRESHING_MS * 4);
      });
      expect(view.result.current.phase).toBe("refreshing");

      // 取得が終わったら表示を戻す
      view.rerender({ isRefreshing: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MIN_REFRESHING_MS);
      });
      expect(view.result.current.phase).toBe("idle");
      expect(view.result.current.distance).toBe(0);
    });

    it("取得中のフラグが下りないままでも上限で表示を戻す", async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const { container, view } = setup(onRefresh, 0, true);

      drag(container, [
        [100, 100],
        [100, 300],
      ]);
      await act(async () => {
        container.dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MAX_EXTERNAL_REFRESHING_MS + MIN_REFRESHING_MS);
      });
      expect(view.result.current.phase).toBe("idle");
    });
  });
});
