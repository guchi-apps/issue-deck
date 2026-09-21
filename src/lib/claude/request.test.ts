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
    findUnique.mockResolvedValue({
      appAiModel: "claude-haiku-4-5",
      appAiModelReasoning: "claude-haiku-4-5",
    });
    resetClaudeApiUsage();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
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

  it("利用枠不足の429は再試行せず、原因とリクエストIDを返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "insufficient_quota", message: "利用枠が不足しています" } }),
          { status: 429, headers: { "content-type": "application/json", "x-request-id": "req_quota" } },
        ),
      ),
    );

    const { response, json, error } = await callClaudeMessages({
      feature: "plan_usage",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 1, messages: [] },
    });

    expect(response.status).toBe(429);
    expect(json).toBeNull();
    expect(error).toEqual({ code: "insufficient_quota", requestId: "req_quota" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getClaudeApiUsageSummary(NOW).features).toEqual([]);
  });

  it("OpenAIの一時的なレート制限は待機後に1回だけ再試行する", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-5.6-luna" });
    process.env.OPENAI_API_KEY = "openai-test-token";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ output_text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = callClaudeMessages({
      feature: "issue_suggest",
      token: "anthropic-token",
      body: { max_tokens: 16, messages: [] },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toMatchObject({ response: { status: 200 }, json: { content: [{ text: "ok" }] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("原因診断・新規アプリ相談だけ判断用モデルを使う", async () => {
    findUnique.mockResolvedValue({
      appAiModel: "claude-haiku-4-5",
      appAiModelReasoning: "claude-sonnet-5",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "new_app_consult",
      token: "test-token",
      body: { max_tokens: 8, messages: [] },
    });
    await callClaudeMessages({
      feature: "issue_summary",
      token: "test-token",
      body: { max_tokens: 8, messages: [] },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("claude-sonnet-5");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).model).toBe("claude-haiku-4-5");
  });

  it("GPTモデルへは画像ブロックをinput_imageへ変換して送る（#3243）", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-5.6-terra" });
    process.env.OPENAI_API_KEY = "openai-test-token";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "gpt-5.6-terra",
        output: [{ type: "message", content: [{ type: "output_text", text: "回答" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "issue_image_extract",
      token: "anthropic-token",
      body: {
        max_tokens: 8,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
              { type: "text", text: "読み取って" },
            ],
          },
        ],
      },
    });

    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,QUJD" },
          { type: "input_text", text: "読み取って" },
        ],
      },
    ]);
  });

  it("GPTモデルはResponses APIへ変換し、応答を既存形式へ正規化する", async () => {
    findUnique.mockResolvedValue({ appAiModelReasoning: "gpt-5.6-terra" });
    process.env.OPENAI_API_KEY = "openai-test-token";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "gpt-5.6-terra-2026-08-01",
        output: [{ type: "message", content: [{ type: "output_text", text: "回答" }] }],
        usage: {
          input_tokens: 90,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 30 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callClaudeMessages({
      feature: "new_app_consult",
      token: "anthropic-token",
      body: {
        max_tokens: 128,
        system: "指示",
        messages: [{ role: "user", content: "質問" }],
        output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer openai-test-token");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: "質問" }],
      instructions: "指示",
      max_output_tokens: 128,
      text: {
        format: {
          type: "json_schema",
          name: "response",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
    expect(json?.content?.[0]?.text).toBe("回答");
    expect(getClaudeApiUsageSummary(NOW).totalLast24h).toEqual({
      calls: 1,
      inputTokens: 90,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
    });
  });

  it("GPTモデル選択時にOpenAI APIキーが無ければ未設定を返す", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-5.6-luna" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { response, json } = await callClaudeMessages({
      feature: "issue_summary",
      token: "anthropic-token",
      body: { max_tokens: 16, messages: [] },
    });

    expect(response.status).toBe(501);
    expect(json).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
