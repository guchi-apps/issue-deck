const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export type ClaudeRateLimit = {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

export async function fetchClaudeRateLimit(apiKey: string): Promise<ClaudeRateLimit> {
  // GitHubの/rate_limitのような無料の専用エンドポイントがAnthropic APIには無いため、
  // 最小コストのMessages APIリクエストを送り、そのレスポンスヘッダーからトークンのレート制限を読み取る。
  const res = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (!res.ok && res.status !== 429) {
    throw new Error(`Anthropic API request failed: ${res.status} ${ANTHROPIC_API}/v1/messages`);
  }

  const limit = Number(res.headers.get("anthropic-ratelimit-tokens-limit"));
  const remaining = Number(res.headers.get("anthropic-ratelimit-tokens-remaining"));
  const resetHeader = res.headers.get("anthropic-ratelimit-tokens-reset");
  const reset = resetHeader ? Math.floor(new Date(resetHeader).getTime() / 1000) : NaN;

  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    throw new Error("Anthropic APIのレート制限情報を取得できませんでした");
  }

  return { limit, remaining, used: limit - remaining, reset };
}
