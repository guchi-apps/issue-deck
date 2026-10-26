import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClaudeApiUsageSummary, resetClaudeApiUsage } from "@/lib/claude/api-usage";
import { callClaudeMessages, getAppAiToken } from "@/lib/claude/request";

const { findUnique, runAppAiOnCodex } = vi.hoisted(() => ({ findUnique: vi.fn(), runAppAiOnCodex: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { appSetting: { findUnique } },
}));

// Codex経路の中身（ジョブ投入・待ち）は app-ai-codex.test.ts で確かめる。ここでは振り分けだけを見る
vi.mock("@/lib/claude/app-ai-codex", () => ({
  CODEX_APP_AI_TOKEN: "codex-cli",
  CODEX_EXCLUDED_FEATURES: new Set(["plan_usage", "chat_investigation"]),
  runAppAiOnCodex,
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
    runAppAiOnCodex.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
      feature: "comment_summary",
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
    expect(error).toEqual({ code: "insufficient_quota", requestId: "req_quota", retryAt: null });
    expect(fetch).toHaveBeenCalledTimes(1);
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
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "sys" },
      ],
      messages: [],
    });
  });

  // OAuthトークンは名乗りが独立した先頭ブロックでないとSonnet・Opusを429で拒否する（#5006）
  it.each([
    ["systemが無い", undefined, []],
    ["文字列", "sys", [{ type: "text", text: "sys" }]],
    [
      "ブロック配列",
      [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
      [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
    ],
  ])("systemが%sでも先頭にClaude Codeの名乗りブロックを置く", async (_label, system, rest) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "release_review_recommend",
      token: "test-token",
      body: { max_tokens: 8, messages: [], ...(system === undefined ? {} : { system }) },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ...rest,
    ]);
  });

  it("旧IDで保存されたclaude-sonnet-5はSonnet 5.5へ読み替えて送る（#3612）", async () => {
    findUnique.mockResolvedValue({ appAiModel: "claude-sonnet-5" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "comment_summary",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 8, messages: [] },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("claude-sonnet-5-5");
  });

  it("保存済みのアプリ内AIモデルでbodyの指定を上書きする", async () => {
    findUnique.mockResolvedValue({ appAiModel: "claude-sonnet-5-5" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({
      feature: "comment_summary",
      token: "test-token",
      body: { model: "claude-haiku-4-5", max_tokens: 8, messages: [] },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("claude-sonnet-5-5");
  });

  it("原因診断・新規アプリ相談だけ判断用モデルを使う", async () => {
    findUnique.mockResolvedValue({
      appAiModel: "claude-haiku-4-5",
      appAiModelReasoning: "claude-sonnet-5-5",
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
      feature: "comment_summary",
      token: "test-token",
      body: { max_tokens: 8, messages: [] },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("claude-sonnet-5-5");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).model).toBe("claude-haiku-4-5");
  });

  it("GPT系が選ばれた機能はサブPCのCodex CLIで実行し、Claude APIにもOpenAI APIにもリクエストしない（#5067）", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-6-luna", appAiModelReasoning: "gpt-5.6-terra" });
    process.env.OPENAI_API_KEY = "openai-test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    runAppAiOnCodex.mockResolvedValue({ text: "要約です", model: "codex-cli/gpt-6-luna" });

    const summary = await callClaudeMessages({
      feature: "comment_summary",
      token: "codex-cli",
      body: { max_tokens: 16, messages: [{ role: "user", content: "要約して" }] },
    });
    await callClaudeMessages({
      feature: "new_app_consult",
      token: "codex-cli",
      timeoutMs: 5_000,
      body: { max_tokens: 16, messages: [] },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.response.ok).toBe(true);
    expect(summary.json?.content?.[0]?.text).toBe("要約です");
    expect(summary.json?.model).toBe("codex-cli/gpt-6-luna");
    expect(runAppAiOnCodex.mock.calls[0][0]).toMatchObject({ feature: "comment_summary", model: "gpt-6-luna" });
    expect(runAppAiOnCodex.mock.calls[1][0]).toMatchObject({ feature: "new_app_consult", model: "gpt-5.6-terra", timeoutMs: 5_000 });
    // Claude系の使用量としては数えない（Codex側の記録は受け口が`codex-cli/<model>`で行う）
    expect(getClaudeApiUsageSummary(NOW).totalLast24h.calls).toBe(0);
  });

  it("Codex経路の失敗はそのまま投げ、Claudeへは戻さない（#5067）", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-6-luna" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    runAppAiOnCodex.mockRejectedValue(new Error("Codex CLIで実行できませんでした: サブPCのCodex CLIがログインしていません"));

    await expect(
      callClaudeMessages({ feature: "issue_search", token: "codex-cli", body: { max_tokens: 16, messages: [] } }),
    ).rejects.toThrow("ログインしていません");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("プラン枠の取得はGPT系を選んでいてもClaude系の既定モデルで実行する", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-6-luna" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaudeMessages({ feature: "plan_usage", token: "anthropic-token", body: { max_tokens: 1, messages: [] } });

    expect(runAppAiOnCodex).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("claude-haiku-4-5");
  });

  it("Codex経路ではClaudeのOAuthトークンを前提にせず目印を返し、Claude系ではOAuthトークンを返す", async () => {
    findUnique.mockResolvedValue({ appAiModel: "gpt-6-luna", appAiModelReasoning: "claude-sonnet-5-5" });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await expect(getAppAiToken("comment_summary")).resolves.toBe("codex-cli");
    await expect(getAppAiToken("manual_step_fix")).resolves.toBeNull();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    await expect(getAppAiToken("manual_step_fix")).resolves.toBe("oauth-token");
    await expect(getAppAiToken("plan_usage")).resolves.toBe("oauth-token");
  });
});
