// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import type { ClaudeUsage } from "@/lib/claude/usage";
import type { QuotaEstimate } from "@/lib/session-usage-view";

// 表示は日本時間へ固定した（#1977）ので、瞬間はUTCで指定する。
// 2026-08-04T03:00:00Z = 日本時間の12:00。
const NOW_MS = Date.parse("2026-08-04T03:00:00Z");

/** 5時間枠の途中（経過40%・使用10%）。 */
function usage(overrides: Partial<ClaudeUsage["windows"][number]> = {}): ClaudeUsage {
  const durationMs = 5 * 60 * 60_000;
  return {
    windows: [
      {
        key: "5h",
        label: "5時間",
        usedPercent: 10,
        remainingPercent: 90,
        // 経過40% = 残り3時間
        resetsAt: (NOW_MS + durationMs * 0.6) / 1000,
        status: "allowed",
        durationMs,
        ...overrides,
      },
    ],
    fetchedAt: NOW_MS,
    stale: false,
  };
}

function render1(data: ClaudeUsage, quotaEstimate: QuotaEstimate | null = null) {
  return render(
    <ClaudeUsageCard
      data={data}
      isLoading={false}
      error={null}
      notConfigured={false}
      quotaEstimate={quotaEstimate}
    />,
  );
}

describe("ClaudeUsageCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("バーは残量ではなく使用率を描き、経過時間は目盛りで出す", () => {
    const { container } = render1(usage());
    const fill = container.querySelector<HTMLElement>('[data-slot="usage-meter-fill"]');
    const tick = container.querySelector<HTMLElement>('[data-slot="usage-meter-tick"]');
    expect(fill?.style.width).toBe("10%");
    expect(tick?.style.left).toBe("40%");
    expect(screen.getByText("使用 10%")).not.toBeNull();
    expect(screen.getByText("経過 40%")).not.toBeNull();
  });

  it("リセットは残り時間の一文で出し、絶対時刻はツールチップへ回す", () => {
    render1(usage());
    const reset = screen.getByText("あと3時間でリセット");
    expect(reset.getAttribute("title")).toBe("15:00 (あと3時間)");
  });

  it("残量が十分でも停止中なら警告色にする", () => {
    const { container } = render1(usage({ status: "rejected" }));
    const fill = container.querySelector<HTMLElement>('[data-slot="usage-meter-fill"]');
    expect(fill?.className).toContain("bg-destructive");
  });

  it("換算レートが渡されれば5時間枠の下に実測換算の注記を出す（#2988）", () => {
    render1(usage(), { usdPerPercent: 1.5, windowStartMs: NOW_MS - 3_600_000, windowCostUsd: 15 });
    expect(screen.getByText(/1% ≈ \$1\.50/)).not.toBeNull();
    expect(screen.getByText(/\$15\.00/)).not.toBeNull();
  });

  it("換算レートが無ければ注記を出さない", () => {
    render1(usage(), null);
    expect(screen.queryByText(/実測換算/)).toBeNull();
  });

  it("週間枠を5時間枠より先に表示する（#3195）", () => {
    render1({
      ...usage(),
      windows: [
        usage().windows[0],
        {
          key: "7d",
          label: "週間",
          usedPercent: 80,
          remainingPercent: 20,
          resetsAt: (NOW_MS + 24 * 60 * 60_000) / 1000,
          status: "allowed",
          durationMs: 7 * 24 * 60 * 60_000,
        },
      ],
    });

    const labels = screen.getAllByRole("meter").map((meter) => meter.getAttribute("aria-label"));
    expect(labels).toEqual(["週間の使用量", "5時間の使用量"]);
  });
});
