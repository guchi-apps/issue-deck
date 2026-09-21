// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useSessionUsage,
  type SessionUsagePlan,
  type SessionUsageResponse,
} from "@/hooks/use-session-usage";
import { buildSessionUsageSummary, type QuotaEstimate } from "@/lib/session-usage-view";

const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

const QUOTA: QuotaEstimate = { usdPerPercent: 0.3, windowStartMs: NOW_MS, windowCostUsd: 6 };

/** 呼ぶたびに別のオブジェクトを返す（前の参照を引き継いだかどうかを見分けるため） */
function response(days: number, quotaEstimate: QuotaEstimate | null = null): SessionUsageResponse {
  return {
    ...buildSessionUsageSummary({ entries: [], nowMs: NOW_MS, days, reportedAt: null }),
    quotaEstimate,
    currentSessions: [],
  };
}

function planResponse(marker: string, quotaEstimate: QuotaEstimate | null = null): SessionUsagePlan {
  return {
    planUsage: { claude: { windows: [], stale: false, marker } as never, codex: null },
    planNotConfigured: { claude: false, codex: false },
    quotaEstimate,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
/** 集計の応答に載せる換算。1回目の取得（キャッシュが冷えている）と取り直しで変える */
let daysQuotas: (QuotaEstimate | null)[];
let planQuota: QuotaEstimate | null;
/** プラン枠の応答を手動で返すための待ち */
let planGate: Promise<void> | null;

beforeEach(() => {
  let planCount = 0;
  let daysCount = 0;
  daysQuotas = [null];
  planQuota = null;
  planGate = null;
  fetchMock = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    if (params.get("plan") === "1") {
      planCount += 1;
      if (planGate) await planGate;
      return { ok: true, json: async () => planResponse(`plan-${planCount}`, planQuota) };
    }
    if (params.get("current") === "1") {
      return { ok: true, json: async () => ({ currentSessions: [] }) };
    }
    const days = Number(params.get("days"));
    const quota = daysQuotas[Math.min(daysCount, daysQuotas.length - 1)];
    daysCount += 1;
    return { ok: true, json: async () => response(days, quota) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function callsOf(kind: "plan" | "days"): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => (kind === "plan" ? url.includes("plan=1") : url.includes("days=")));
}

describe("useSessionUsage の期間変更（#3257）", () => {
  it("期間を変えても前のデータを残し、プラン枠は取り直さず、実行中のセッションは前の参照を引き継ぐ", async () => {
    const { result, rerender } = renderHook(({ days }) => useSessionUsage(true, days), {
      initialProps: { days: 7 },
    });
    await flush();
    const first = result.current.data;
    const firstPlan = result.current.plan.data;
    expect(first?.days).toBe(7);
    expect(firstPlan).not.toBeNull();

    rerender({ days: 30 });
    // 取得中も前の応答を消さない
    expect(result.current.data).toBe(first);
    await flush();

    const next = result.current.data;
    expect(next?.days).toBe(30);
    expect(result.current.plan.data).toBe(firstPlan);
    expect(next?.currentSessions).toBe(first?.currentSessions);
    expect(callsOf("days")).toHaveLength(2);
    expect(callsOf("plan")).toHaveLength(1);
  });

  it("更新ボタン（refresh）ではプラン枠を含めて取り直す", async () => {
    const { result } = renderHook(() => useSessionUsage(true, 7));
    await flush();
    const firstPlan = result.current.plan.data;

    act(() => result.current.refresh());
    // 取り直している間は空にして「読み込み中」に戻す
    expect(result.current.data).toBeNull();
    expect(result.current.plan.data).toBeNull();
    await flush();

    expect(result.current.plan.data).not.toBe(firstPlan);
    expect(callsOf("plan")).toHaveLength(2);
  });
});

describe("useSessionUsage の段階表示（#3304）", () => {
  it("プラン枠を待たずに集計が出る", async () => {
    let release: () => void = () => {};
    planGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useSessionUsage(true, 7));
    await flush();

    // 集計は届いているが、プラン枠はまだ取得中（dataもerrorもnull）
    expect(result.current.data?.days).toBe(7);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.plan).toEqual({ data: null, error: null });

    release();
    await flush();
    expect(result.current.plan.data).not.toBeNull();
  });

  it("プラン枠の取得に失敗しても集計は出し、エラーはプラン枠の側だけに持つ", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("plan=1")) return { ok: false, status: 500, json: async () => ({}) };
      if (String(url).includes("current=1")) {
        return { ok: true, json: async () => ({ currentSessions: [] }) };
      }
      return { ok: true, json: async () => response(7) };
    });
    const { result } = renderHook(() => useSessionUsage(true, 7));
    await flush();

    expect(result.current.data?.days).toBe(7);
    expect(result.current.error).toBeNull();
    expect(result.current.plan.data).toBeNull();
    expect(result.current.plan.error).toContain("500");
  });

  it("集計が換算なしで先に届き、プラン枠で換算が求まったら、集計を1回だけ取り直す", async () => {
    daysQuotas = [null, QUOTA];
    planQuota = QUOTA;
    const { result } = renderHook(() => useSessionUsage(true, 7));
    await flush();

    expect(callsOf("days")).toHaveLength(2);
    expect(result.current.data?.quotaEstimate).toEqual(QUOTA);
    // 取り直しでも画面を「読み込み中」に戻さない
    expect(result.current.isLoading).toBe(false);
  });

  it("取り直しても換算が求まらなければ、取り直しを繰り返さない", async () => {
    daysQuotas = [null];
    planQuota = QUOTA;
    renderHook(() => useSessionUsage(true, 7));
    await flush();
    await flush();

    expect(callsOf("days")).toHaveLength(2);
  });

  it("プラン枠に換算が無ければ、集計を取り直さない", async () => {
    daysQuotas = [null];
    planQuota = null;
    renderHook(() => useSessionUsage(true, 7));
    await flush();

    expect(callsOf("days")).toHaveLength(1);
  });
});
