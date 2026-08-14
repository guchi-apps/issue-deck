// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1353",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1353,
    state: "ALIVE",
    exitStatus: null,
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    firstSeenAt: "2026-08-14T09:00:00.000Z",
    // pollerが1巡ごとに更新するので、生きている限り常に「今」に近い
    lastReportedAt: NOW.toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IssueSessionStatus", () => {
  /**
   * #1353。バッジの時刻に`lastReportedAt`を添えていたため、**何時間前の入力待ちでも
   * 「たった今」**と出ていた。古い値が残っていることに画面から気づけない。
   */
  it("入力待ちにはフックが報告してきた時刻を添える", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <IssueSessionStatus
        session={session({
          activity: "WAITING_INPUT",
          activityAt: "2026-08-14T09:00:00.000Z",
        })}
      />,
    );

    expect(screen.getByText("3時間前")).toBeTruthy();
    expect(screen.getByText(/入力を待っています/)).toBeTruthy();
  });

  it("様子の報告が無ければpollerが最後に見た時刻を添える", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(<IssueSessionStatus session={session()} />);

    expect(screen.getByText("たった今")).toBeTruthy();
    expect(screen.getByText(/subpcで実行中/)).toBeTruthy();
  });

  it("入力待ちのときだけRemote Controlの導線を出す", () => {
    render(
      <IssueSessionStatus
        session={session({
          activity: "WAITING_INPUT",
          activityAt: NOW.toISOString(),
          remoteControlUrl: "https://claude.ai/code/session_01ABC",
        })}
      />,
    );

    expect(
      screen.getByRole("link", { name: /Remote Controlで開く/ }).getAttribute("href"),
    ).toBe("https://claude.ai/code/session_01ABC");
  });
});
