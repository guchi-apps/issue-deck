// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBranchFlow } from "@/hooks/use-branch-flow";

const ONE_MINUTE_MS = 60_000;

let hidden = false;
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      repositories: [],
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

describe("useBranchFlow の自動更新（#1767）", () => {
  it("間隔が渡されなければ時間が経っても取り直さない（既定は自動更新しない）", async () => {
    renderHook(() => useBranchFlow(true));
    await advance(ONE_MINUTE_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("間隔を渡すとその間隔ごとに取り直す", async () => {
    renderHook(() => useBranchFlow(true, ONE_MINUTE_MS));
    // マウント時の取得が飛んでいる間の重複は投げない（有効化直後の1回は初回取得と重なる）
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(ONE_MINUTE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(ONE_MINUTE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("画面を開いていない間は自動更新しない", async () => {
    renderHook(() => useBranchFlow(false, ONE_MINUTE_MS));
    await advance(ONE_MINUTE_MS * 3);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("裏に回っているタブでは取りに行かず、前面へ戻った時点で取り直す", async () => {
    renderHook(() => useBranchFlow(true, ONE_MINUTE_MS));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = true;
    await advance(ONE_MINUTE_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("自動更新では読み込み表示を出さず、更新アイコン用の`isRefreshing`だけを立てる", async () => {
    const { result } = renderHook(() => useBranchFlow(true, ONE_MINUTE_MS));
    await advance(0);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isRefreshing).toBe(false);

    // 取得の応答を保留して、その間の状態を観測する
    let resolveFetch: (() => void) | null = null;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return {
        ok: true,
        json: async () => ({
          repositories: [],
          failedRepositories: [],
          fetchedAt: new Date().toISOString(),
        }),
      };
    });

    await advance(ONE_MINUTE_MS);
    const loadingDuringPoll = result.current.isLoading;
    const refreshingDuringPoll = result.current.isRefreshing;
    await act(async () => {
      resolveFetch?.();
    });

    expect(loadingDuringPoll).toBe(false);
    expect(refreshingDuringPoll).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("自動更新の失敗は画面に出さず、次の周期で回復する", async () => {
    const { result } = renderHook(() => useBranchFlow(true, ONE_MINUTE_MS));
    await advance(0);

    fetchMock.mockImplementationOnce(async () => {
      throw new Error("ネットワークエラー");
    });
    await advance(ONE_MINUTE_MS);

    expect(result.current.error).toBeNull();
  });
});
