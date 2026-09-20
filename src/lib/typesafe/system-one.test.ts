import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClaudeApiUsageSummary, resetClaudeApiUsage } from "@/lib/claude/api-usage";
import { askSystemOne, hasTypeSafeApiKey } from "@/lib/typesafe/system-one";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ANSWER = {
  model: "jev-1.13.0",
  answers: { model: { type: "choice", choice: "opus", confidence: 0.82, probabilities: {} } },
  usage: { input_tokens: 420, output_tokens: 0 },
};

describe("askSystemOne", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "test-key";
    resetClaudeApiUsage();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("エンドポイント・認証・本文の形をそのまま送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANSWER));
    vi.stubGlobal("fetch", fetchMock);

    await askSystemOne({
      feature: "model_pick",
      state: { タイトル: "直す" },
      questions: { model: { type: "choice", criteria: { opus: null, sonnet: null } } },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "jev-latest",
      state: { タイトル: "直す" },
      questions: { model: { type: "choice", criteria: { opus: null, sonnet: null } } },
    });
  });

  // 出力は常に0だが、入力ぶんは課金される。アプリ内AIの消費量の画面で見えないと、
  // 判定をJevへ移した後に「どこにも出ない費用」が生まれる
  it("応答のusageを機能別の消費量として計上する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(ANSWER)));

    await askSystemOne({ feature: "model_pick", state: "x", questions: {} });

    const summary = getClaudeApiUsageSummary(NOW);
    const feature = summary.features.find((entry) => entry.key === "model_pick");
    expect(feature?.last24h.calls).toBe(1);
    expect(feature?.last24h.inputTokens).toBe(420);
    expect(feature?.last24h.outputTokens).toBe(0);
    // 計上するモデル名は応答が返した実体（エイリアスのままだと単価表とずれる）
    expect(feature?.models[0].model).toBe("jev-1.13.0");
  });

  it("APIキーが無ければ呼び出さずnullを返す", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await askSystemOne({ feature: "model_pick", state: "x", questions: {} })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("エラー応答・壊れた応答・通信の失敗はnullにする（呼び出し元が従来経路へ倒せるように）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 401)));
    expect(await askSystemOne({ feature: "model_pick", state: "x", questions: {} })).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    expect(await askSystemOne({ feature: "model_pick", state: "x", questions: {} })).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await askSystemOne({ feature: "model_pick", state: "x", questions: {} })).toBeNull();

    // 失敗した呼び出しは消費量に数えない
    expect(getClaudeApiUsageSummary(NOW).features).toHaveLength(0);
  });

  it("answersが無い応答は採らない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ model: "jev-1.13.0" })));
    expect(await askSystemOne({ feature: "model_pick", state: "x", questions: {} })).toBeNull();
  });
});

describe("TYPESAFE_BASE_URL", () => {
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_BASE_URL;
    vi.unstubAllGlobals();
  });

  // キーを持たない環境から経路を通して確かめるための逃げ道（公式SDKと同じ環境変数）
  it("指定があればその宛先へ送り、末尾のスラッシュは足さない", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9999/";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANSWER));
    vi.stubGlobal("fetch", fetchMock);

    await askSystemOne({ feature: "model_pick", state: "x", questions: {} });

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/v1/systemone");
  });
});

describe("hasTypeSafeApiKey", () => {
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
  });

  it("キーの有無を返す", () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(hasTypeSafeApiKey()).toBe(false);
    process.env.TYPESAFE_API_KEY = "k";
    expect(hasTypeSafeApiKey()).toBe(true);
  });
});
