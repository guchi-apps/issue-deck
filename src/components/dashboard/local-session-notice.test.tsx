// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalSessionApprovalNotice,
  LocalSessionCommentNotice,
  LocalSessionWaitingInputNotice,
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
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    models: [],
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
  it("Codexでは端末から答えるよう案内する", () => {
    render(<LocalSessionApprovalNotice session={session({ codexThreadKnown: false })} />);
    expect(screen.getByText(/答えるには端末を操作してください/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Remote Control/ })).toBeNull();
  });

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

/**
 * #2061: 計画の承認・修正は同じ画面の上部（計画パネル）から送れる。ここで
 * 「Remote Controlから伝えてください」と言い続けると、アプリで完結できることが読み取れない。
 */
describe("LocalSessionWaitingInputNotice", () => {
  afterEach(() => {
    cleanup();
  });

  it("計画への返事を待っているときは、上のパネルへ案内する", () => {
    render(<LocalSessionWaitingInputNotice session={session()} planDecisionPending />);

    expect(screen.getByText(/上の「計画の承認を待っています」から承認・修正を送れます/)).toBeTruthy();
  });

  it("計画待ち以外は従来どおりRemote Controlへ案内する", () => {
    render(<LocalSessionWaitingInputNotice session={session()} />);

    expect(screen.getByText(/承認・修正はRemote Controlから伝えてください/)).toBeTruthy();
  });

  it("Codexの入力待ちは端末から答えるよう案内する", () => {
    render(<LocalSessionWaitingInputNotice session={session({ codexThreadKnown: false })} />);
    expect(screen.getByText(/承認・修正は端末から伝えてください/)).toBeTruthy();
    expect(screen.queryByText(/Remote Control/)).toBeNull();
  });
});
