import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGithubStatusSummary } from "@/lib/github/status";

describe("fetchGithubStatusSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Statuspage APIのレスポンスをGithubStatusSummaryへ変換する", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: { indicator: "major", description: "Partial System Outage" },
        components: [
          { id: "abc", name: "Issues", status: "operational" },
          { id: "def", name: "Actions", status: "major_outage" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGithubStatusSummary();

    expect(result).toEqual({
      indicator: "major",
      description: "Partial System Outage",
      components: [
        { id: "abc", name: "Issues", status: "operational" },
        { id: "def", name: "Actions", status: "major_outage" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.githubstatus.com/api/v2/summary.json",
      { cache: "no-store" },
    );
  });

  it("indicatorが未知の値の場合はnoneへフォールバックする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: { indicator: "unknown-value", description: "?" },
          components: [],
        }),
      }),
    );

    const result = await fetchGithubStatusSummary();

    expect(result.indicator).toBe("none");
  });

  it("レスポンスがエラーの場合は例外を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(fetchGithubStatusSummary()).rejects.toThrow("503");
  });
});
