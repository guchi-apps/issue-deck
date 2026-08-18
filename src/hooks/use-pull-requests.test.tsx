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

// #1947。PR画面から「更新」ボタンを外したので、引っ張って更新した結果が嘘にならないこと
// （空振りしない・失敗が画面に出る）を確かめる
describe("usePullRequests の引っ張って更新（#1947）", () => {
  it("取得が飛んでいる最中に呼ぶと、その取得の完了を待ってから返す", async () => {
    // 応答を手元で止められる取得にして、「飛んでいる最中」を作る
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock = vi.fn(async () => {
      await pending;
      return {
        ok: true,
        json: async () => ({ pullRequests: [], failedRepositories: [], fetchedAt: "2026-08-18T00:00:00Z" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePullRequests("open", null));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let settled = false;
    const pulled = result.current.refreshFromPull().then(() => {
      settled = true;
    });

    // マウント時の取得がまだ飛んでいる間は解決しない（＝空振りして即座に返らない）
    await advance(0);
    expect(settled).toBe(false);
    // 重ねて投げてもいない（GitHub APIを無駄に消費しない）
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release!();
      await pulled;
    });
    expect(settled).toBe(true);
  });

  it("失敗を画面に出す。自動更新（refreshInBackground）の失敗は黙ったまま", async () => {
    // 1回目（マウント時）は成功させ、2回目以降を失敗させる
    let shouldFail = false;
    fetchMock = vi.fn(async () =>
      shouldFail
        ? {
            ok: false,
            status: 403,
            json: async () => ({ error: "github_api_error", message: "API rate limit exceeded" }),
          }
        : {
            ok: true,
            json: async () => ({
              pullRequests: [],
              failedRepositories: [],
              fetchedAt: "2026-08-18T00:00:00Z",
            }),
          },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePullRequests("open", null));
    await advance(0);
    expect(result.current.error).toBeNull();

    shouldFail = true;

    // 自動更新と同じ扱いの取り直しは、失敗しても画面へ出さない（瞬断は次の周期で回復するため）
    await act(async () => {
      result.current.refreshInBackground();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBeNull();

    // ユーザーが自分で引っ張った取得の失敗は出す（更新ボタンが無い以上、黙ると何も起きない）
    await act(async () => {
      await result.current.refreshFromPull();
    });
    expect(result.current.error).toBe("API rate limit exceeded");
    // 読み込み表示（「読み込み中...」）は出さないまま
    expect(result.current.isLoading).toBe(false);
  });
});
