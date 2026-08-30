import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClaudeApiUsageSummary, resetClaudeApiUsage } from "@/lib/claude/api-usage";
import { callClaudeMessages } from "@/lib/claude/request";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { appSetting: { findUnique } },
}));

const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callClaudeMessages", () => {
  beforeEach(() => {
    findUnique.mockResolvedValue({ appAiModel: "claude-haiku-4-5" });
    resetClaudeApiUsage();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("応答のusageを機能別の消費量として計上する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        }),
      ),
    );

    const { response, json } = await callClaudeMessages({
      feature: "issue_summary",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 16, messages: [] },
    });

    expect(response.ok).toBe(true);
    expect(json?.content?.[0]?.text).toBe("ok");

    const summary = getClaudeApiUsageSummary(NOW);
    expect(summary.totalLast24h).toEqual({
      calls: 1,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
    });
    // モデルは応答が返した実際の値を使う。
    expect(summary.features[0].models[0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("usageが無い応答でも呼び出し回数だけは数える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] })),
    );

    await callClaudeMessages({
      feature: "issue_search",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 16, messages: [] },
    });

    const summary = getClaudeApiUsageSummary(NOW);
    expect(summary.totalLast24h.calls).toBe(1);
    expect(summary.totalLast24h.inputTokens).toBe(0);
    expect(summary.features[0].models[0].model).toBe("claude-haiku-4-5");
  });

  it("拒否された呼び出し（429など）は計上せず、例外も投げない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "rate_limited" }, 429)),
    );

    const { response, json } = await callClaudeMessages({
      feature: "plan_usage",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 1, messages: [] },
    });

    expect(response.status).toBe(429);
    expect(json).toBeNull();
    expect(getClaudeApiUsageSummary(NOW).features).toEqual([]);
  });

  it("送信先・認証ヘッダ・bodyをそのまま渡す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "new_app_consult",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 8, system: "sys", messages: [] },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 8,
      system: "sys",
      messages: [],
    });
  });

  it("保存済みのアプリ内AIモデルでbodyの指定を上書きする", async () => {
    findUnique.mockResolvedValue({ appAiModel: "claude-sonnet-5" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "issue_summary",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 8, messages: [] },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("claude-sonnet-5");
  });
});
