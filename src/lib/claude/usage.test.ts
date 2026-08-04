import { describe, expect, it } from "vitest";
import { parseUnifiedRateLimitHeaders } from "@/lib/claude/usage";

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
