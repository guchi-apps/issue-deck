// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import type { InstallationRateLimit } from "@/hooks/use-github-rate-limit";

const NOW_MS = new Date(2026, 7, 4, 12, 0, 0).getTime();

/** 1時間枠の途中（経過25%・使用1%）。 */
const DATA: InstallationRateLimit[] = [
  {
    accountLogin: "guchi-apps",
    resources: [
      {
        key: "core",
        label: "REST",
        remaining: 5258,
        used: 42,
        limit: 5300,
        // 残り45分 = 経過25%
        reset: (NOW_MS + 45 * 60_000) / 1000,
      },
    ],
  },
];

describe("GithubRateLimitList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("バーは残量ではなく使用率を描き、残量には実数を添える", () => {
    const { container } = render(
      <GithubRateLimitList data={DATA} isLoading={false} error={null} />,
    );
    const fill = container.querySelector<HTMLElement>('[data-slot="usage-meter-fill"]');
    const tick = container.querySelector<HTMLElement>('[data-slot="usage-meter-tick"]');
    // 残り99%なので、塗りは1%ぶんだけ。
    expect(Number.parseFloat(fill?.style.width ?? "")).toBeCloseTo(0.79, 1);
    expect(Number.parseFloat(tick?.style.left ?? "")).toBeCloseTo(25, 1);
    expect(screen.getByText("(5,258 / 5,300)", { exact: false })).not.toBeNull();
    expect(screen.getByText("あと45分でリセット")).not.toBeNull();
  });
});
