// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexUsageCard } from "@/components/dashboard/codex-usage-card";

vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.parse("2026-08-30T07:00:00Z") }));

afterEach(cleanup);

describe("CodexUsageCard", () => {
  it("5時間枠は表示せず週間枠だけを表示する", () => {
    render(
      <CodexUsageCard
        data={{
          host: "subpc",
          source: "transcript",
          planType: "plus",
          fetchedAt: Date.parse("2026-08-30T06:00:00Z"),
          stale: true,
          windows: [
            { key: "primary", label: "5時間", usedPercent: 45, remainingPercent: 55, resetsAt: 1788076800, durationMs: 18_000_000, expired: false },
            { key: "secondary", label: "週間", usedPercent: 7, remainingPercent: 93, resetsAt: 1788663600, durationMs: 604_800_000, expired: false },
          ],
        }}
        isLoading={false}
        error={null}
        notConfigured={false}
      />,
    );
    expect(screen.getByText("週間")).toBeTruthy();
    expect(screen.queryByText("5時間")).toBeNull();
    expect(screen.queryByRole("meter", { name: "5時間の使用量" })).toBeNull();
    expect(screen.queryByText("最新の報告から15分以上経過しています")).toBeNull();
    expect(
      screen.getByText("ops-dashboardから取得できないため、サブPCの転記（最終観測 8/30 15:00）を表示しています"),
    ).toBeTruthy();
  });

  it("リセット済みの枠は推定値を出さず、取得できていないと書く（#3052）", () => {
    render(
      <CodexUsageCard
        data={{
          host: "subpc",
          source: "transcript",
          planType: "plus",
          fetchedAt: Date.parse("2026-08-20T06:00:00Z"),
          stale: true,
          windows: [
            { key: "secondary", label: "週間", usedPercent: 70, remainingPercent: 30, resetsAt: 1787000000, durationMs: 604_800_000, expired: true },
          ],
        }}
        isLoading={false}
        error={null}
        notConfigured={false}
      />,
    );
    expect(screen.getByText("リセット後の使用量はまだ取得できていません")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("ops-dashboardから読めた値には取得元の注記を出さない", () => {
    render(
      <CodexUsageCard
        data={{
          host: "ops-dashboard",
          source: "ops-dashboard",
          planType: "prolite",
          fetchedAt: Date.parse("2026-08-30T06:55:00Z"),
          stale: false,
          windows: [
            { key: "secondary", label: "週間", usedPercent: 51, remainingPercent: 49, resetsAt: 1788663600, durationMs: 604_800_000, expired: false },
          ],
        }}
        isLoading={false}
        error={null}
        notConfigured={false}
      />,
    );
    expect(screen.queryByText(/サブPCの転記/)).toBeNull();
  });

  it("未報告を説明する", () => {
    render(<CodexUsageCard data={null} isLoading={false} error={null} notConfigured />);
    expect(screen.getByText("Codex使用量の報告がまだありません")).toBeTruthy();
  });
});
