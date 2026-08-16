// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDispatchState } from "@/hooks/use-dispatch-state";

/**
 * #1773。実行キューの更新インジケーターの材料（最後に取得できた時刻・取得中か・いまの間隔）。
 *
 * 表示側（`dispatch-queue-content.tsx`）はこのフックが返す値をそのまま出すだけなので、
 * 「速すぎて回転が見えない」「失敗しても時刻が進む」といった取り違えはここでしか防げない。
 */
const EMPTY_STATE = { hosts: [], jobs: [], sessions: [], concurrency: 2 };

function respond(body: unknown = EMPTY_STATE) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDispatchState の更新インジケーター（#1773）", () => {
  it("取得できた時刻を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond()),
    );

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(result.current.fetchedAt).not.toBeNull());
  });

  /**
   * 取得の失敗は表面化しない作りなので、失敗しても時刻を進めると
   * 「更新できていない」と「更新した結果が同じ」の区別が付かなくなる
   */
  it("取得に失敗したら時刻を進めない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.fetchedAt).toBeNull();
  });

  /**
   * 叩き先はDBの読み取りだけで数十msで返る。素直に実装すると回転が1周もせずに消え、
   * 点滅にしか見えない
   */
  it("取得が一瞬で終わっても0.5秒は取得中のままにする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond()),
    );

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(result.current.fetchedAt).not.toBeNull());
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.isFetching).toBe(false);
  });

  it("refreshは次の自動更新を待たずに取り直す", async () => {
    const fetchMock = vi.fn(() => respond());
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => result.current.refresh());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  /** 画面に出す「20秒ごと」と実際の周期がずれないよう、effectと同じ判定を使う */
  it("動いているジョブが無い間は20秒間隔を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond()),
    );

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.pollIntervalMs).toBe(20_000);
  });

  it("未完了のジョブがある間は5秒間隔を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        respond({
          ...EMPTY_STATE,
          jobs: [{ id: "job-1", status: "RUNNING" }],
        }),
      ),
    );

    const { result } = renderHook(() => useDispatchState(true));

    await waitFor(() => expect(result.current.jobs.length).toBe(1));
    expect(result.current.pollIntervalMs).toBe(5_000);
  });
});
