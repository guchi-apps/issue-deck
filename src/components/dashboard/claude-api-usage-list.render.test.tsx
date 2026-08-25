// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeApiUsageList } from "@/components/dashboard/claude-api-usage-list";
import type { ClaudeApiTotals, ClaudeApiUsageSummary } from "@/lib/claude/api-usage-totals";

// 表示は日本時間へ固定した（#1977）ので、瞬間はUTCで指定する。
// 2026-08-04T03:00:00Z = 日本時間の12:00。
const NOW_MS = Date.parse("2026-08-04T03:00:00Z");

function totals(overrides: Partial<ClaudeApiTotals> = {}): ClaudeApiTotals {
  return {
    calls: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<ClaudeApiUsageSummary> = {}): ClaudeApiUsageSummary {
  const week = totals({ calls: 5, inputTokens: 4_000, outputTokens: 800 });
  return {
    measuringSince: NOW_MS - 60 * 60_000,
    totalLast24h: totals(),
    totalLast7d: week,
    features: [
      {
        key: "issue_summary",
        label: "Issueの要約",
        last24h: totals(),
        last7d: week,
        models: [{ model: "claude-haiku-4-5", last24h: totals(), last7d: week }],
      },
    ],
    ...overrides,
  };
}

function render1(data: ClaudeApiUsageSummary | null) {
  return render(<ClaudeApiUsageList data={data} isLoading={false} error={null} />);
}

describe("ClaudeApiUsageList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("既定では過去1日の呼び出し回数とトークン数を出す", () => {
    render1(summary());
    expect(screen.getByText("過去1日 2回・1,200トークン")).not.toBeNull();
  });

  it("「過去7日」へ切り替えると7日間の集計に変わる", () => {
    render1(summary());
    fireEvent.click(screen.getByRole("button", { name: "過去7日" }));
    expect(screen.getByText("過去7日 5回・4,800トークン")).not.toBeNull();
  });

  it("内訳に入らない消費があることを、畳んだ状態でも書いておく", () => {
    render1(summary());
    expect(
      screen.getByText(
        "issue-deck本体の呼び出しのみ。無人実行・ローカルセッションの消費は上のプラン枠に含まれます。",
      ),
    ).not.toBeNull();
  });

  it("展開すると機能別・モデル別の内訳を出す", () => {
    render1(summary());
    expect(screen.queryByText("Issueの要約")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("Issueの要約")).not.toBeNull();
    expect(screen.getByText("2回・1,200")).not.toBeNull();
    expect(screen.getByText("claude-haiku-4-5")).not.toBeNull();
    expect(screen.getByText("入力 1,000 / 出力 200")).not.toBeNull();
  });

  it("キャッシュを使った呼び出しはトークン数にも内訳にも含める", () => {
    const cached = totals({ cacheReadTokens: 3_000, cacheCreationTokens: 500 });
    render1(
      summary({
        totalLast24h: cached,
        features: [
          {
            key: "new_app_consult",
            label: "新規アプリの相談",
            last24h: cached,
            last7d: cached,
            models: [{ model: "claude-haiku-4-5", last24h: cached, last7d: cached }],
          },
        ],
      }),
    );

    expect(screen.getByText("過去1日 2回・4,700トークン")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("入力 1,000 / 出力 200 / キャッシュ 3,500")).not.toBeNull();
  });

  it("まだ記録が無ければその旨を出す", () => {
    render1(summary({ features: [] }));
    expect(
      screen.getByText("まだ消費が記録されていません（issue-deck本体の呼び出しのみ）"),
    ).not.toBeNull();
  });
});
