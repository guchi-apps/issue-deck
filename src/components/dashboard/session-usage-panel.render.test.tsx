// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionUsagePanel } from "@/components/dashboard/session-usage-panel";
import type { SessionUsageResponse } from "@/hooks/use-session-usage";
import {
  buildSessionUsageSummary,
  type QuotaScale,
  type SessionUsageEntry,
} from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）の描画。
 *
 * **確かめたいのは3つ。** (1) Issueの行を開くとtmuxセッション（転記）1本ごとの明細が出ること
 * ——一覧をIssue単位に畳んでいるので、開けなければ「セッションごとに見たい」という元の要求が
 * 満たせない。(2) 単位の切り替えでドルと枠%が入れ替わること。(3) 枠の物差しが無いときに
 * 「枠%」を押しても金額が壊れないこと（`Infinity%`を出さない）。
 */

/** 2026-08-30 12:00 JST */
const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

function entry(overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  return {
    sessionId: "s1",
    host: "subpc",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 2504,
    responses: 100,
    inputTokens: 1_000,
    cacheCreateTokens: 2_000,
    cacheReadTokens: 7_000,
    outputTokens: 500,
    contextTokens: 10_000,
    costUsd: 20,
    models: ["claude-opus-5"],
    startedAt: "2026-08-30T01:00:00.000Z",
    endedAt: "2026-08-30T02:00:00.000Z",
    ...overrides,
  };
}

const quota: QuotaScale = {
  windowKey: "7d",
  windowLabel: "週間",
  usedPercent: 20,
  windowStart: "2026-08-23T03:00:00.000Z",
  windowEnd: "2026-08-30T03:00:00.000Z",
  windowCostUsd: 40,
  // 1%あたり$2 → $20 は枠の10%相当
  usdPerPercent: 2,
};

function response(
  entries: SessionUsageEntry[],
  scale: QuotaScale | null = quota,
): SessionUsageResponse {
  return {
    ...buildSessionUsageSummary({
      entries,
      nowMs: NOW_MS,
      days: 7,
      reportedAt: "2026-08-30T02:55:00.000Z",
      quota: scale,
    }),
    planUsage: null,
    planNotConfigured: true,
  };
}

function renderPanel(data: SessionUsageResponse, props: Record<string, unknown> = {}) {
  return render(
    <SessionUsagePanel
      data={data}
      isLoading={false}
      error={null}
      days={7}
      onChangeDays={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

afterEach(() => cleanup());

describe("SessionUsagePanel", () => {
  it("Issueの行を開くと、そのIssueで走った転記1本ごとの明細が出る", () => {
    renderPanel(
      response([
        entry({ sessionId: "impl", costUsd: 20, responses: 100 }),
        entry({ sessionId: "plan", kind: "plan-review", costUsd: 1, responses: 3 }),
      ]),
    );

    // 明細だけを見る（「種別別」の内訳にも同じ語が並ぶため）。
    const detail = screen.getByText("Issue・セッション別").closest("section") as HTMLElement;

    // 畳まれている間は、そのIssueの合計だけが出ている。
    expect(within(detail).getByText("#2504")).toBeTruthy();
    expect(within(detail).getByText("2セッション")).toBeTruthy();
    expect(within(detail).queryByText("計画レビュー")).toBeNull();

    fireEvent.click(within(detail).getByRole("button", { expanded: false }));

    // 開くと転記ごとの行が出る（実装・計画レビューの2本）。
    expect(within(detail).getByText("実装")).toBeTruthy();
    expect(within(detail).getByText("計画レビュー")).toBeTruthy();
    expect(within(detail).getByText("3応答")).toBeTruthy();
  });

  it("単位を「枠%」へ切り替えると、金額がプラン枠の割合になる", () => {
    renderPanel(response([entry({ costUsd: 20 })]));

    // 既定はAPI換算のドル。
    expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "枠%" }));

    // 1%あたり$2の物差しなので、$20 は枠の10%相当。
    expect(screen.getAllByText("10%").length).toBeGreaterThan(0);
    expect(screen.queryByText("$20.00")).toBeNull();
  });

  it("枠の物差しが無ければ、枠%を押してもドルのまま出す", () => {
    renderPanel(response([entry({ costUsd: 20 })], null));

    fireEvent.click(screen.getByRole("button", { name: "枠%" }));

    expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/プラン枠を取得できていないため/)).toBeTruthy();
  });

  it("Issueを開く導線は、リポジトリとIssue番号が揃っている行にだけ出す", () => {
    const onOpenIssue = vi.fn();
    renderPanel(
      response([
        entry({ sessionId: "impl" }),
        entry({ sessionId: "q", kind: "question", repository: null, issueNumber: null, costUsd: 1 }),
      ]),
      { onOpenIssue },
    );

    const buttons = screen.getAllByRole("button", { name: "Issueを開く" });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    expect(onOpenIssue).toHaveBeenCalledWith("issue-deck", 2504);
  });

  it("記録が無いときは、報告待ちであることを出す", () => {
    renderPanel(response([]));
    expect(screen.getByText(/記録がありません。サブPCのpollerが報告すると出ます/)).toBeTruthy();
  });

  it("金額がAPI換算の目安であることを必ず断る", () => {
    const { container } = renderPanel(response([entry()]));
    expect(within(container).getByText(/金額はAPI換算の目安です/)).toBeTruthy();
    expect(within(container).getByText(/サブスクの実費ではありません/)).toBeTruthy();
  });
});
