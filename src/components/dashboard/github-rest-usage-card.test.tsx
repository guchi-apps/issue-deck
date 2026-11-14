// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubRestUsageCard } from "@/components/dashboard/github-rest-usage-card";
import type { GithubRestUsage } from "@/hooks/use-github-rest-usage";

const NOW = Date.parse("2026-08-30T07:00:00Z");
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

afterEach(cleanup);

const base = {
  measuringSince: NOW,
  currentHourStartedAt: NOW,
  totalCurrentHour: 0,
  totalLast60min: 0,
  totalLast24h: 0,
  features: [{ key: "sync", label: "Issue同期", currentHour: 5, last60min: 5, last24h: 5, endpoints: [] }],
} as unknown as GithubRestUsage;

function withLimit(remaining: number): GithubRestUsage {
  return {
    ...base,
    rateLimits: [
      {
        accountLogin: "guchi-apps",
        used: 5000 - remaining,
        limit: 5000,
        remaining,
        reset: NOW / 1000 + 1800,
        windowStartedAt: NOW - 1800_000,
        measuredInWindow: 100,
        unmeasuredInWindow: 50,
      },
    ],
  };
}

describe("GithubRestUsageCard", () => {
  it("残り・上限と用途別を表示する", () => {
    render(<GithubRestUsageCard data={withLimit(3420)} isLoading={false} error={null} />);
    expect(screen.getByText("guchi-apps")).toBeTruthy();
    expect(screen.getByText(/3,420 \/ 5,000/)).toBeTruthy();
    expect(screen.getByText("Issue同期")).toBeTruthy();
  });

  it("取得に失敗したインストールは注記だけを出す", () => {
    render(
      <GithubRestUsageCard
        data={{ ...base, rateLimits: [{ accountLogin: "x", error: "fetch_failed" }] }}
        isLoading={false}
        error={null}
      />,
    );
    expect(screen.getByText("x: 使用量を取得できませんでした")).toBeTruthy();
  });

  it("エラーを表示する", () => {
    render(<GithubRestUsageCard data={null} isLoading={false} error="取得に失敗しました (500)" />);
    expect(screen.getByText("取得に失敗しました (500)")).toBeTruthy();
  });
});
