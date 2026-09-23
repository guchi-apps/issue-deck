// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIssuePolling } from "@/hooks/use-issue-polling";
import { ISSUE_POLL_INTERVAL_MS } from "@/lib/auto-refresh";

/**
 * #1797。Issue一覧のヘッダーへ「いつ時点の内容か」を出せるようにしたぶんの取り決め。
 *
 * **取れなかった周回で時刻を進めない**のが要点で、失敗は握り潰して次の周回で回復させる作りの
 * ため、叩いた時刻を入れると取れていないのに「たった今」と出てしまう。
 */
const SERVER_RENDERED_AT = "2026-08-22T05:30:00.000Z";
const API_FETCHED_AT = "2026-08-22T05:30:10.000Z";

let hidden = false;
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(response: { ok: boolean; fetchedAt?: string }) {
  fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.ok ? 200 : 500,
    headers: new Headers(),
    json: async () => ({ issues: [], fetchedAt: response.fetchedAt }),
  }));
  vi.stubGlobal("fetch", fetchMock);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.useFakeTimers();
  stubFetch({ ok: true, fetchedAt: API_FETCHED_AT });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useIssuePolling が返す取得の状態（#1797）", () => {
  it("最初はサーバーで描いた時刻を出し、取り直せたらAPIの取得時刻へ進める", async () => {
    const { result } = renderHook(() => useIssuePolling(vi.fn(), SERVER_RENDERED_AT));

    // 初回ポーリングまでの10秒間も「HH:MM時点」が消えないようにする
    expect(result.current.fetchedAt).toBe(SERVER_RENDERED_AT);

    await advance(ISSUE_POLL_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.fetchedAt).toBe(API_FETCHED_AT);
  });

  it("取れなかった周回では取得時刻を進めない", async () => {
    stubFetch({ ok: false });
    const { result } = renderHook(() => useIssuePolling(vi.fn(), SERVER_RENDERED_AT));

    await advance(ISSUE_POLL_INTERVAL_MS);

    expect(result.current.fetchedAt).toBe(SERVER_RENDERED_AT);
  });

  it("この一覧は常時自動更新で、画面に出す間隔も実際の周期と同じ値を返す", () => {
    const { result } = renderHook(() => useIssuePolling(vi.fn()));

    expect(result.current.autoRefresh).toBe(true);
    expect(result.current.pollIntervalMs).toBe(ISSUE_POLL_INTERVAL_MS);
    // 渡さなければ未取得（サーバー描画の時刻を持たない一覧）
    expect(result.current.fetchedAt).toBeNull();
  });
});

/**
 * #3387。低速回線向けの取り決め。一覧は全Issueの本文を含み大きいので、変化が無い周回は304で
 * 済ませ、遅い取得を重ねず、応答が返らない取得はタイムアウトで打ち切って次の周回で回復させる。
 */
describe("useIssuePolling の通信量と詰まりへの備え（#3387）", () => {
  const ETAG = 'W/"v1"';

  function jsonResponse(fetchedAt: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ etag: ETAG, "x-fetched-at": fetchedAt }),
      json: async () => ({ issues: [], fetchedAt }),
    };
  }

  it("2回目以降は前回のETagを送り、304なら一覧を渡し直さず取得時刻だけ進める", async () => {
    const later = "2026-08-22T05:30:20.000Z";
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(API_FETCHED_AT))
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: new Headers({ etag: ETAG, "x-fetched-at": later }),
        json: async () => {
          throw new Error("304には本文が無い");
        },
      });
    vi.stubGlobal("fetch", fetchMock);
    const onIssues = vi.fn();
    const { result } = renderHook(() => useIssuePolling(onIssues));

    await advance(ISSUE_POLL_INTERVAL_MS);
    expect(onIssues).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();

    await advance(ISSUE_POLL_INTERVAL_MS);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ "If-None-Match": ETAG });
    expect(onIssues).toHaveBeenCalledTimes(1);
    expect(result.current.fetchedAt).toBe(later);
  });

  it("前の取得が飛んでいる間は、次の周回で重ねて取りに行かない", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(jsonResponse(API_FETCHED_AT));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useIssuePolling(vi.fn()));

    await advance(ISSUE_POLL_INTERVAL_MS);
    await advance(ISSUE_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(jsonResponse(API_FETCHED_AT));
    });
    await advance(ISSUE_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("応答が返らない取得はタイムアウトで打ち切り、以後の周回で取り直せる", async () => {
    fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      )
      .mockResolvedValue(jsonResponse(API_FETCHED_AT));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useIssuePolling(vi.fn(), SERVER_RENDERED_AT));

    await advance(ISSUE_POLL_INTERVAL_MS);
    // 既定のタイムアウト（30秒）を過ぎるまでは重ねない
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(20_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.fetchedAt).toBe(API_FETCHED_AT);
  });
});
