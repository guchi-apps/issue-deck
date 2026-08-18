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
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    activity: null,
    activityAt: null,
    remoteControlUrl: REMOTE_URL,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
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
  it("生きているセッションでは、ここに書いても届かないことと答える場所を出す（#1264・#1903）", () => {
    render(<LocalSessionApprovalNotice session={session()} />);
    expect(screen.getByText(/ここに書いた回答はセッションに届きません/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Remote Controlで答える/ }).getAttribute("href"),
    ).toBe(REMOTE_URL);
  });

  it("「確認待ちを外す」を押すと何が起きるかを、押す前に出す（#1903）", () => {
    render(<LocalSessionApprovalNotice session={session()} />);
    expect(screen.getByText(/確認待ちの印が外れるだけです/)).toBeTruthy();
  });

  it("終わったセッションでは終了していることを出し、Remote Controlへは送らない（#1903）", () => {
    render(<LocalSessionApprovalNotice session={session({ state: "GONE" })} />);
    expect(screen.getByText(/終了しています/)).toBeTruthy();
    expect(screen.getByText(/セッションを復旧/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Remote Control/ })).toBeNull();
  });

  // 記録が無いだけで、終了したとは限らない（24時間で落ちる・pollerの外で起こした場合）
  it("セッションが分からないときは終了したと言わず、届かないことだけを出す", () => {
    render(<LocalSessionApprovalNotice session={null} />);
    expect(screen.getByText(/走っているセッションには届きません/)).toBeTruthy();
    expect(screen.queryByText(/終了しています/)).toBeNull();
  });
});
