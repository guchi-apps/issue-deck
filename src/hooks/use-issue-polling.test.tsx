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
