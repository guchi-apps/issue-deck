// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import type { ClaudeUsage } from "@/lib/claude/usage";

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

function render1(data: ClaudeUsage) {
  return render(
    <ClaudeUsageCard data={data} isLoading={false} error={null} notConfigured={false} />,
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
});
