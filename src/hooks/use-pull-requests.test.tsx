// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePullRequests } from "@/hooks/use-pull-requests";

const POLL_INTERVAL_MS = 10_000;

let hidden = false;
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      pullRequests: [],
      failedRepositories: [],
      fetchedAt: new Date().toISOString(),
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
}

/** タイマーを進めたうえで、その間に走った取得のPromiseを消化する */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.useFakeTimers();
  stubFetch();
});

afterEach(() => {
  // vitestの`globals`を有効にしていないため、testing-libraryの自動クリーンアップが働かない。
  // アンマウントしないと前のテストのポーリングが次のテストの`fetch`まで数えてしまう。
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePullRequests の自動更新（#1531・#1767）", () => {
  it("間隔が渡されなければ（null）時間が経っても取り直さない", async () => {
    renderHook(() => usePullRequests("open", null));
    await advance(POLL_INTERVAL_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("間隔を渡すとその間隔ごとに取り直す", async () => {
    renderHook(() => usePullRequests("open", POLL_INTERVAL_MS));
    // マウント時の取得が飛んでいる間の重複は投げない（有効化直後の1回は初回取得と重なる）
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ビューを開いて自動更新が有効になった時点で、次の周期を待たずに1回取り直す", async () => {
    const { rerender } = renderHook(
      ({ intervalMs }: { intervalMs: number | null }) => usePullRequests("open", intervalMs),
      { initialProps: { intervalMs: null as number | null } },
    );
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ intervalMs: POLL_INTERVAL_MS });
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("裏に回っているタブでは取りに行かず、前面へ戻った時点で取り直す", async () => {
    renderHook(() => usePullRequests("open", POLL_INTERVAL_MS));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = true;
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("自動更新では読み込み表示を出さない（更新ボタンが10秒ごとに無効化されない）", async () => {
    const { result } = renderHook(() => usePullRequests("open", POLL_INTERVAL_MS));
    await advance(0);
    expect(result.current.isLoading).toBe(false);

    let loadingDuringPoll = false;
    // 取得の応答を保留して、その間の`isLoading`を観測する
    let resolveFetch: (() => void) | null = null;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return {
        ok: true,
        json: async () => ({
          pullRequests: [],
          failedRepositories: [],
          fetchedAt: new Date().toISOString(),
        }),
      };
    });

    await advance(POLL_INTERVAL_MS);
    loadingDuringPoll = result.current.isLoading;
    await act(async () => {
      resolveFetch?.();
    });

    expect(loadingDuringPoll).toBe(false);
  });

  it("自動更新の取得中は`isRefreshing`が立つ（更新アイコンを回すため。#1767）", async () => {
    const { result } = renderHook(() => usePullRequests("open", POLL_INTERVAL_MS));
    await advance(0);
    expect(result.current.isRefreshing).toBe(false);

    let resolveFetch: (() => void) | null = null;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return {
        ok: true,
        json: async () => ({
          pullRequests: [],
          failedRepositories: [],
          fetchedAt: new Date().toISOString(),
        }),
      };
    });

    await advance(POLL_INTERVAL_MS);
    const refreshingDuringPoll = result.current.isRefreshing;
    await act(async () => {
      resolveFetch?.();
    });

    expect(refreshingDuringPoll).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("自動更新の失敗は画面に出さず、次の周期で回復する", async () => {
    const { result } = renderHook(() => usePullRequests("open", POLL_INTERVAL_MS));
    await advance(0);

    fetchMock.mockImplementationOnce(async () => {
      throw new Error("ネットワークエラー");
    });
    await advance(POLL_INTERVAL_MS);

    expect(result.current.error).toBeNull();
  });
});
