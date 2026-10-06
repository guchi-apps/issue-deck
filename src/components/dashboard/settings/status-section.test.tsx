// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusSection } from "@/components/dashboard/settings/status-section";

afterEach(cleanup);

describe("StatusSection", () => {
  it("GitHub障害状況に取得時刻を出す（#3827）", () => {
    const fetchedAt = "2026-10-03T04:15:00.000Z";
    render(
      <StatusSection
        githubStatus={{
          data: { indicator: "none", description: "All Systems Operational", components: [], fetchedAt },
          isLoading: false,
          error: null,
        }}
      />,
    );

    expect(screen.getByText("取得 10/3 13:15")).toBeTruthy();
  });

  it("取得前は取得時刻を出さない", () => {
    render(<StatusSection githubStatus={{ data: null, isLoading: true, error: null }} />);

    expect(screen.queryByText(/取得 /)).toBeNull();
  });

  it("GitHub公式のステータスページへ別タブで開くリンクを出す（#4064）", () => {
    render(<StatusSection githubStatus={{ data: null, isLoading: true, error: null }} />);

    const link = screen.getByRole("link", { name: "公式ページ" });
    expect(link.getAttribute("href")).toBe("https://www.githubstatus.com/");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
