import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOpsDashboardCodexUsageCache,
  fetchOpsDashboardCodexUsage,
  parseOpsDashboardCodexUsage,
} from "@/lib/dispatch/ops-dashboard-codex-usage";

const snapshot = {
  fetchedAt: "2026-09-18T01:00:00.000Z",
  providers: [
    { id: "claude", status: "ok", plan: "Max", windows: [] },
    {
      id: "chatgpt",
      name: "ChatGPT",
      status: "ok",
      plan: "Plus",
      windows: [
        { label: "5時間", usedPercent: 12, resetsAt: "2026-09-18T04:00:00.000Z", windowSeconds: 18_000 },
        { label: "週間", usedPercent: 34.5, resetsAt: "2026-09-22T00:00:00.000Z", windowSeconds: 604_800 },
      ],
    },
  ],
};

describe("parseOpsDashboardCodexUsage", () => {
  it("chatgptの2つの枠をprimary・secondaryへ変換する", () => {
    expect(parseOpsDashboardCodexUsage(snapshot)).toEqual({
      host: "ops-dashboard",
      planType: "Plus",
      fetchedAt: Date.parse(snapshot.fetchedAt),
      stale: false,
      windows: [
        {
          key: "primary",
          label: "5時間",
          usedPercent: 12,
          remainingPercent: 88,
          resetsAt: Date.parse("2026-09-18T04:00:00.000Z") / 1000,
          durationMs: 18_000_000,
        },
        {
          key: "secondary",
          label: "週間",
          usedPercent: 34.5,
          remainingPercent: 65.5,
          resetsAt: Date.parse("2026-09-22T00:00:00.000Z") / 1000,
          durationMs: 604_800_000,
        },
      ],
    });
  });

  it("枠が1つだけなら週間側（画面が出すsecondary）として扱う", () => {
    const chatgpt = { ...snapshot.providers[1], windows: [snapshot.providers[1].windows[1]] };
    const usage = parseOpsDashboardCodexUsage({ ...snapshot, providers: [chatgpt] });
    expect(usage?.windows.map((window) => [window.key, window.label])).toEqual([["secondary", "週間"]]);
  });

  it.each([
    { name: "chatgptが無い", value: { ...snapshot, providers: [snapshot.providers[0]] } },
    { name: "未設定", value: { ...snapshot, providers: [{ ...snapshot.providers[1], status: "unconfigured" }] } },
    { name: "枠が空", value: { ...snapshot, providers: [{ ...snapshot.providers[1], windows: [] }] } },
    {
      name: "リセット時刻が無い",
      value: {
        ...snapshot,
        providers: [{ ...snapshot.providers[1], windows: [{ ...snapshot.providers[1].windows[1], resetsAt: null }] }],
      },
    },
  ])("読めない応答はnull（$name）", ({ value }) => {
    expect(parseOpsDashboardCodexUsage(value)).toBeNull();
  });
});

describe("fetchOpsDashboardCodexUsage", () => {
  beforeEach(() => {
    clearOpsDashboardCodexUsageCache();
    vi.stubEnv("OPS_DASHBOARD_URL", "http://127.0.0.1:3110");
    vi.stubEnv("OPS_API_TOKEN", "token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("設定が無ければ問い合わせない", async () => {
    vi.stubEnv("OPS_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOpsDashboardCodexUsage()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("トークン付きで取得し、5分はキャッシュする", async () => {
    const fetchMock = vi.fn(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.parse("2026-09-18T01:00:00Z");

    expect((await fetchOpsDashboardCodexUsage(now))?.planType).toBe("Plus");
    await fetchOpsDashboardCodexUsage(now + 4 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:3110/api/ai-usage");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token" });

    await fetchOpsDashboardCodexUsage(now + 6 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("失敗したらnullを返し、30秒後に取り直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.parse("2026-09-18T01:00:00Z");

    await expect(fetchOpsDashboardCodexUsage(now)).resolves.toBeNull();
    await fetchOpsDashboardCodexUsage(now + 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchOpsDashboardCodexUsage(now + 31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
