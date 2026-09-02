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

function render1(data: ClaudeApiUsageSummary | null, days = 1) {
  return render(<ClaudeApiUsageList data={data} isLoading={false} error={null} days={days} />);
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

  it("1日を選んでいるときは過去1日の呼び出し回数とトークン数を出す", () => {
    render1(summary());
    expect(screen.getByText("過去1日 2回・1,200トークン")).not.toBeNull();
  });

  // #2752。カード自前の「過去1日／過去7日」ボタンは廃し、画面上部の期間セレクタに従う。
  it("7日を選ぶと7日間の集計に変わり、カード自前の切り替えは持たない", () => {
    render1(summary(), 7);
    expect(screen.getByText("過去7日 5回・4,800トークン")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "過去7日" })).toBeNull();
    expect(screen.queryByRole("button", { name: "過去1日" })).toBeNull();
  });

  /**
   * #2752。集計は直近7日ぶんしか無い（`api-usage.ts`の`USAGE_WINDOW_MS`）ので、
   * **30日を選んでも7日の値を出す。黙って出すと期間の指定と食い違う**ため断りを添える。
   */
  it("30日を選んだときは7日の値を出し、そのことを断る", () => {
    render1(summary(), 30);
    expect(screen.getByText("直近7日 5回・4,800トークン")).not.toBeNull();
    expect(
      screen.getByText("この内訳は直近7日ぶんです（それより前は保存していません）。"),
    ).not.toBeNull();
  });

  /**
   * #2752。11機能のうち呼ばれるのは数件で、0回のカードが並ぶとスマホでは合計へ辿り着く前に
   * 画面が尽きていた。**件数は残す**ので、畳んだままでも機能の存在は分かる。
   */
  it("その期間に0回だった機能は畳み、押すと名前を出す", () => {
    const used = totals();
    const zero = totals({ calls: 0, inputTokens: 0, outputTokens: 0 });
    render1(
      summary({
        features: [
          {
            key: "issue_summary",
            label: "Issueの要約",
            last24h: used,
            last7d: used,
            models: [{ model: "claude-haiku-4-5", last24h: used, last7d: used }],
          },
          {
            key: "issue_order",
            label: "着手順の提案",
            last24h: zero,
            last7d: zero,
            models: [{ model: "claude-haiku-4-5", last24h: zero, last7d: zero }],
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Issueの要約")).not.toBeNull();
    expect(screen.queryByText("着手順の提案")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /0回の機能 1件/ }));
    expect(screen.getByText("着手順の提案")).not.toBeNull();
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
    // 回数・トークン数のうしろにAPI換算の目安金額が付く（#2717）。
    // Haiku 4.5で入力1,000（$1/MTok）＋出力200（$5/MTok）＝ $0.002
    expect(screen.getByText("2回・1,200")).not.toBeNull();
    expect(screen.getByText("/ $0.0020")).not.toBeNull();
    expect(screen.getByText("claude-haiku-4-5")).not.toBeNull();
    expect(screen.getByText("入力 1,000 / 出力 200 / $0.0020")).not.toBeNull();
  });

  // #2717。**足りない分を0として足すと、実際より安い金額が出る。**
  it("単価を知らないモデルが混じっている機能には金額を出さない", () => {
    render1(
      summary({
        features: [
          {
            key: "issue_summary",
            label: "Issueの要約",
            last24h: totals(),
            last7d: totals(),
            models: [
              { model: "claude-haiku-4-5", last24h: totals(), last7d: totals() },
              { model: "未知のモデル", last24h: totals(), last7d: totals() },
            ],
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    // 機能の行には金額が付かない
    expect(screen.queryByText(/^\/ \$/)).toBeNull();
    // モデル単位では、単価を知っている行にだけ金額が付く
    expect(screen.getByText("入力 1,000 / 出力 200 / $0.0020")).not.toBeNull();
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
    // 金額もキャッシュぶんを含める（読み出しは入力の0.1倍、書き込みは1.25倍）。
    // $0.002 ＋ 3,000×$0.1/MTok ＋ 500×$1.25/MTok = $0.0029
    expect(
      screen.getByText("入力 1,000 / 出力 200 / キャッシュ 3,500 / $0.0029"),
    ).not.toBeNull();
  });

  it("まだ記録が無ければその旨を出す", () => {
    render1(summary({ features: [] }));
    expect(
      screen.getByText("まだ消費が記録されていません（issue-deck本体の呼び出しのみ）"),
    ).not.toBeNull();
  });
});
