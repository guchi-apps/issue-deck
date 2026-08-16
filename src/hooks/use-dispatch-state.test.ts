// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
  // **必ず片付ける**（#1815）。このフックは他のインスタンスへ取り直しを配るため、
  // 前のテストで立てたものが残っていると次のテストの取得回数に混ざる
  cleanup();
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

/**
 * #1815。積んだジョブを自分の状態へ足すだけでは、**同じ画面の別のコンポーネントには届かない。**
 * Issueを作成して続けて起動した直後（「作成+実装開始」）がこれで、ジョブを積むのは作成側の
 * ダイアログの取得口、押した結果を出すのは裏で開いているIssue詳細の取得口という別インスタンスに
 * なるため、詳細側は次のポーリング（20秒後）まで押す前と同じ開始ボタンを出したままだった。
 */
describe("積んだ結果を同じ画面の他のインスタンスへ配る（#1815）", () => {
  /** 状態の取得（GET）だけを数える。積む操作（POST）と混ぜない */
  function makeFetchMock() {
    const mock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ job: { id: "job-1", status: "QUEUED" } }),
        } as Response);
      }
      return respond();
    });
    return {
      mock,
      loadCount: () => mock.mock.calls.filter(([, init]) => init?.method !== "POST").length,
    };
  }

  const enqueueParams = {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1815,
    hostName: "subpc",
  };

  it("片方でenqueueすると、もう片方も取り直す", async () => {
    const { mock, loadCount } = makeFetchMock();
    vi.stubGlobal("fetch", mock);

    const starter = renderHook(() => useDispatchState(true));
    renderHook(() => useDispatchState(true));

    await waitFor(() => expect(loadCount()).toBe(2));

    await act(async () => {
      await starter.result.current.enqueue(enqueueParams);
    });

    // 積んだ本人と、開いたままのもう片方の2つが取り直す
    await waitFor(() => expect(loadCount()).toBe(4));
  });

  it("取得しない設定（enabled=false）のインスタンスは取り直さない", async () => {
    const { mock, loadCount } = makeFetchMock();
    vi.stubGlobal("fetch", mock);

    const starter = renderHook(() => useDispatchState(true));
    renderHook(() => useDispatchState(false));

    await waitFor(() => expect(loadCount()).toBe(1));

    await act(async () => {
      await starter.result.current.enqueue(enqueueParams);
    });

    // 取り直すのは積んだ本人だけ（閉じているダイアログのために取得を増やさない）
    await waitFor(() => expect(loadCount()).toBe(2));
  });
});
