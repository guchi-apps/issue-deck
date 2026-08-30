// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexUsageCard } from "@/components/dashboard/codex-usage-card";

vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.parse("2026-08-30T07:00:00Z") }));

afterEach(cleanup);

describe("CodexUsageCard", () => {
  it("5時間・週間の使用量と古い報告の警告を表示する", () => {
    render(
      <CodexUsageCard
        data={{
          host: "subpc",
          planType: "plus",
          fetchedAt: Date.parse("2026-08-30T06:00:00Z"),
          stale: true,
          windows: [
            { key: "primary", label: "5時間", usedPercent: 45, remainingPercent: 55, resetsAt: 1788076800, durationMs: 18_000_000 },
            { key: "secondary", label: "週間", usedPercent: 7, remainingPercent: 93, resetsAt: 1788663600, durationMs: 604_800_000 },
          ],
        }}
        isLoading={false}
        error={null}
        notConfigured={false}
      />,
    );
    expect(screen.getByText("5時間")).toBeTruthy();
    expect(screen.getByText("週間")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "5時間の使用量" }).getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByText("最新の報告から15分以上経過しています")).toBeTruthy();
  });

  it("未報告を説明する", () => {
    render(<CodexUsageCard data={null} isLoading={false} error={null} notConfigured />);
    expect(screen.getByText("Codex使用量の報告がまだありません")).toBeTruthy();
  });
});
