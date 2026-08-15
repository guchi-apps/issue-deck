// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalSessionApprovalNotice,
  LocalSessionCommentNotice,
} from "@/components/dashboard/local-session-notice";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REMOTE_URL = "https://claude.ai/code/session_01ABC";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1287",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1287,
    issueTitle: null,
    state: "ALIVE",
    exitStatus: null,
    activity: null,
    activityAt: null,
    remoteControlUrl: REMOTE_URL,
    previewUrl: null,
    firstSeenAt: "2026-08-14T00:00:00.000Z",
    lastReportedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("LocalSessionCommentNotice", () => {
  it("ここへのコメントがセッションへ届かないことを出す", () => {
    render(<LocalSessionCommentNotice session={session()} />);
    expect(screen.getByText(/走っているセッションには届きません/)).toBeTruthy();
  });

  it("Remote Controlを開く導線を出す", () => {
    render(<LocalSessionCommentNotice session={session()} />);
    expect(
      screen.getByRole("link", { name: /Remote Controlで開く/ }).getAttribute("href"),
    ).toBe(REMOTE_URL);
  });

  it("セッションが分からなくても案内自体は出す（届かないことはセッションの有無によらない）", () => {
    render(<LocalSessionCommentNotice session={null} />);
    expect(screen.getByText(/走っているセッションには届きません/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Remote Controlで開く/ })).toBeNull();
  });

  it("終わったセッションではRemote Controlの導線を出さない（開いても操作できない）", () => {
    render(<LocalSessionCommentNotice session={session({ state: "GONE" })} />);
    expect(screen.queryByRole("link", { name: /Remote Controlで開く/ })).toBeNull();
  });
});

describe("LocalSessionApprovalNotice", () => {
  it("承認しても走っているセッションが動かないことを出す（#1264の文面を保つ）", () => {
    render(<LocalSessionApprovalNotice session={session()} />);
    expect(screen.getByText(/走っているセッションは動きません/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Remote Controlで開く/ }).getAttribute("href"),
    ).toBe(REMOTE_URL);
  });
});
