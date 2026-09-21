// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionUsage, type SessionUsageResponse } from "@/hooks/use-session-usage";
import { buildSessionUsageSummary } from "@/lib/session-usage-view";

const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

/** 呼ぶたびに別のオブジェクトを返す（前の参照を引き継いだかどうかを見分けるため） */
function response(days: number, marker: string): SessionUsageResponse {
  return {
    ...buildSessionUsageSummary({ entries: [], nowMs: NOW_MS, days, reportedAt: null }),
    planUsage: { claude: { windows: [], stale: false, marker } as never, codex: null },
    planNotConfigured: { claude: false, codex: false },
    quotaEstimate: null,
    currentSessions: [],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let count = 0;
  fetchMock = vi.fn(async (url: string) => {
    const days = Number(new URL(url, "http://localhost").searchParams.get("days"));
    count += 1;
    return { ok: true, json: async () => response(days, `fetch-${count}`) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSessionUsage の期間変更（#3257）", () => {
  it("期間を変えても前のデータを残し、プラン枠と実行中のセッションは前の参照を引き継ぐ", async () => {
    const { result, rerender } = renderHook(({ days }) => useSessionUsage(true, days), {
      initialProps: { days: 7 },
    });
    await flush();
    const first = result.current.data;
    expect(first?.days).toBe(7);

    rerender({ days: 30 });
    // 取得中も前の応答を消さない
    expect(result.current.data).toBe(first);
    await flush();

    const next = result.current.data;
    expect(next?.days).toBe(30);
    expect(next?.planUsage).toBe(first?.planUsage);
    expect(next?.currentSessions).toBe(first?.currentSessions);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("更新ボタン（refresh）ではプラン枠を含めて取り直す", async () => {
    const { result } = renderHook(() => useSessionUsage(true, 7));
    await flush();
    const first = result.current.data;

    act(() => result.current.refresh());
    // 取り直している間は空にして「読み込み中」に戻す
    expect(result.current.data).toBeNull();
    await flush();

    expect(result.current.data?.planUsage).not.toBe(first?.planUsage);
  });
});
