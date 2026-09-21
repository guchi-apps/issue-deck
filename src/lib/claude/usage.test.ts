import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callClaudeMessages = vi.fn();
vi.mock("@/lib/claude/request", () => ({
  get callClaudeMessages() {
    return callClaudeMessages;
  },
}));

import {
  CLAUDE_LOW_REMAINING_PERCENT,
  clearClaudeUsageCache,
  fetchClaudeUsage,
  hasClaudeLowRemainingQuota,
  parseUnifiedRateLimitHeaders,
  peekClaudeFiveHourWindow,
} from "@/lib/claude/usage";

/** 実際の`POST /v1/messages`レスポンスから採取したヘッダ。 */
function realHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-reset": "1785876000",
    "anthropic-ratelimit-unified-5h-utilization": "0.07",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": "1786323600",
    "anthropic-ratelimit-unified-7d-utilization": "0.09",
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-overage-utilization": "0.0",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": "1785876000",
    ...overrides,
  });
}

describe("parseUnifiedRateLimitHeaders", () => {
  it("実レスポンスから5時間枠と週次枠を表示順に取り出す", () => {
    const windows = parseUnifiedRateLimitHeaders(realHeaders());

    expect(windows.map((w) => w.key)).toEqual(["5h", "7d"]);
    expect(windows[0].label).toBe("5時間");
    expect(windows[0].resetsAt).toBe(1785876000);
    expect(windows[0].status).toBe("allowed");
    expect(windows[1].label).toBe("週間");
    expect(windows[1].resetsAt).toBe(1786323600);
  });

  it("固定ウィンドウ長(5時間・週間)を含める", () => {
    const windows = parseUnifiedRateLimitHeaders(realHeaders());

    expect(windows[0].durationMs).toBe(5 * 60 * 60_000);
    expect(windows[1].durationMs).toBe(7 * 24 * 60 * 60_000);
  });

  it("utilizationを比率(0-1)として扱いパーセントに変換する", () => {
    const windows = parseUnifiedRateLimitHeaders(realHeaders());

    expect(windows[0].usedPercent).toBeCloseTo(7);
    expect(windows[0].remainingPercent).toBeCloseTo(93);
    expect(windows[1].usedPercent).toBeCloseTo(9);
    expect(windows[1].remainingPercent).toBeCloseTo(91);
  });

  it("0%と100%を正しく扱う", () => {
    const windows = parseUnifiedRateLimitHeaders(
      realHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "0.0",
        "anthropic-ratelimit-unified-7d-utilization": "1",
      }),
    );

    expect(windows[0].usedPercent).toBe(0);
    expect(windows[0].remainingPercent).toBe(100);
    expect(windows[1].usedPercent).toBe(100);
    expect(windows[1].remainingPercent).toBe(0);
  });

  it("上限超過で1を超える値が来ても100%に丸める", () => {
    const windows = parseUnifiedRateLimitHeaders(
      realHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1.2" }),
    );

    expect(windows[0].usedPercent).toBe(100);
    expect(windows[0].remainingPercent).toBe(0);
  });

  it("警告状態のstatusをそのまま保持する", () => {
    const windows = parseUnifiedRateLimitHeaders(
      realHeaders({ "anthropic-ratelimit-unified-5h-status": "allowed_warning" }),
    );

    expect(windows[0].status).toBe("allowed_warning");
  });

  it("5時間枠または週間枠の残りが警告基準未満なら、実行開始には少なすぎると判定する", () => {
    expect(CLAUDE_LOW_REMAINING_PERCENT).toBe(10);
    expect(
      hasClaudeLowRemainingQuota(
        parseUnifiedRateLimitHeaders(
          realHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.91" }),
        ),
      ),
    ).toBe(true);
    expect(
      hasClaudeLowRemainingQuota(
        parseUnifiedRateLimitHeaders(
          realHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.91" }),
        ),
      ),
    ).toBe(true);
  });

  it("残りが警告基準ちょうど、または枠が無ければ既定を切り替えない", () => {
    expect(
      hasClaudeLowRemainingQuota(
        parseUnifiedRateLimitHeaders(
          realHeaders({
            "anthropic-ratelimit-unified-5h-utilization": "0.9",
            "anthropic-ratelimit-unified-7d-utilization": "0.8",
          }),
        ),
      ),
    ).toBe(false);
    expect(hasClaudeLowRemainingQuota([])).toBe(false);
  });

  it("utilizationが無いウィンドウは除外する", () => {
    const headers = realHeaders();
    headers.delete("anthropic-ratelimit-unified-5h-utilization");

    expect(parseUnifiedRateLimitHeaders(headers).map((w) => w.key)).toEqual(["7d"]);
  });

  it("resetやstatusが欠けていても使用率だけ取り出す", () => {
    const headers = realHeaders();
    headers.delete("anthropic-ratelimit-unified-5h-reset");
    headers.delete("anthropic-ratelimit-unified-5h-status");

    const windows = parseUnifiedRateLimitHeaders(headers);
    expect(windows[0].resetsAt).toBeNull();
    expect(windows[0].status).toBeNull();
    expect(windows[0].usedPercent).toBeCloseTo(7);
  });

  it("数値として解釈できない値は欠損として扱う", () => {
    const windows = parseUnifiedRateLimitHeaders(
      realHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "unexpected",
        "anthropic-ratelimit-unified-7d-reset": "unexpected",
      }),
    );

    expect(windows.map((w) => w.key)).toEqual(["7d"]);
    expect(windows[0].resetsAt).toBeNull();
  });

  it("ヘッダが1つも無ければ空配列を返す", () => {
    expect(parseUnifiedRateLimitHeaders(new Headers())).toEqual([]);
  });
});

describe("fetchClaudeUsageのキャッシュ（#3032）", () => {
  const start = new Date("2026-09-18T10:00:00Z");
  const resetSec = start.getTime() / 1000 + 120;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    clearClaudeUsageCache();
    callClaudeMessages.mockReset();
    callClaudeMessages.mockResolvedValue({
      response: { status: 200, headers: realHeaders({ "anthropic-ratelimit-unified-5h-reset": String(resetSec) }) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("5分以内でもリセット時刻を過ぎたキャッシュは使わない", async () => {
    await fetchClaudeUsage("token");
    vi.setSystemTime(start.getTime() + 60_000);
    await fetchClaudeUsage("token");
    expect(callClaudeMessages).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start.getTime() + 121_000);
    await fetchClaudeUsage("token");
    expect(callClaudeMessages).toHaveBeenCalledTimes(2);
  });

  it("最後に取得した5時間枠のリセット時刻を、取得せずに読める", async () => {
    expect(peekClaudeFiveHourWindow()).toBeNull();
    await fetchClaudeUsage("token");
    const peeked = peekClaudeFiveHourWindow();
    expect(peeked?.resetsAt).toBe(resetSec * 1000);
    expect(peeked?.usedPercent).toBeCloseTo(7);
    expect(callClaudeMessages).toHaveBeenCalledTimes(1);
  });
});
