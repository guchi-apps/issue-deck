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
 * **確かめたいのは3つ。** (1) セッションごとの行が初期状態から出ること、共通スケールの比率が
 * 表示されること。(2) 単位の切り替えでドルと枠%が入れ替わること。(3) 枠の物差しが無いときに
 * 「枠%」を押しても金額が壊れないこと（`Infinity%`を出さない）。
 */

/** 2026-08-30 12:00 JST */
const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

function entry(overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  return {
    agent: "claude",
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
      quotaByAgent: { claude: scale, codex: scale },
    }),
    planUsage: { claude: null, codex: null },
    planNotConfigured: { claude: true, codex: true },
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
  it("ClaudeとCodexを切り替えずに同じ画面へ表示する", () => {
    renderPanel(response([]));
    expect(screen.getByText("Claude プラン枠")).toBeTruthy();
    expect(screen.getByText("Codex プラン枠")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "表示するエージェント" })).toBeNull();
  });
  it("セッションごとの行を初期状態から表示し、最大セッション比を出す", () => {
    renderPanel(
      response([
        entry({ sessionId: "impl", costUsd: 20, responses: 100 }),
        entry({ sessionId: "plan", agent: "codex", models: ["gpt-5.6"], kind: "plan-review", costUsd: 1, responses: 3, contextTokens: 100, outputTokens: 50 }),
      ]),
    );

    // 一覧だけを見る（「種別別」の内訳にも同じ語が並ぶため）。
    const detail = screen.getByText("Issue・セッション別").closest("section") as HTMLElement;

    // セッションごとの2行が最初から出る。
    expect(within(detail).getAllByText("#2504 issue-deck")).toHaveLength(2);
    expect(within(detail).getByText("実装", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("計画レビュー", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("Claude", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("Codex", { exact: false })).toBeTruthy();
    expect(within(detail).getAllByText("100%")).toHaveLength(1);
    expect(within(detail).getByText("1%")).toBeTruthy();
  });

  it("単位を「枠%」へ切り替えると、金額がプラン枠の割合になる", () => {
    renderPanel(response([entry({ costUsd: 20 })]));

    // 既定は重量課金のドル。
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
    expect(screen.getByText("重量課金")).toBeTruthy();
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

  it("リポジトリ別内訳は上位5件を表示し、ボタンで残りを展開・折りたためる", () => {
    const entries = Array.from({ length: 6 }, (_unused, index) =>
      entry({
        sessionId: `repo-${index}`,
        repository: `repository-${index}`,
        costUsd: 6 - index,
      }),
    );
    renderPanel(response(entries));

    const breakdown = screen.getByText("リポジトリ別").closest("section") as HTMLElement;
    expect(within(breakdown).getByText("repository-0")).toBeTruthy();
    expect(within(breakdown).getByText("repository-4")).toBeTruthy();
    expect(within(breakdown).queryByText("repository-5")).toBeNull();

    fireEvent.click(within(breakdown).getByRole("button", { name: "すべて表示（残り 1 リポジトリ）" }));
    expect(within(breakdown).getByText("repository-5")).toBeTruthy();

    fireEvent.click(within(breakdown).getByRole("button", { name: "上位5件のみ表示" }));
    expect(within(breakdown).queryByText("repository-5")).toBeNull();
  });

  it("記録が無いときは、報告待ちであることを出す", () => {
    renderPanel(response([]));
    expect(screen.getByText(/記録がありません。サブPCのpollerが報告すると出ます/)).toBeTruthy();
  });

  it("金額は重量課金として表示し、API換算の注意書きを表示しない", () => {
    const { container } = renderPanel(response([entry()]));
    expect(within(container).getByText("重量課金")).toBeTruthy();
    expect(within(container).queryByText(/金額はAPI換算の目安です/)).toBeNull();
    expect(within(container).queryByText(/サブスクの実費ではありません/)).toBeNull();
  });
});
