// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-08-14T12:00:00.000Z");

const sendSessionControl = vi.fn();

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

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs: [] as DispatchJobView[],
    sessions: [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl,
    cancel: vi.fn(),
    ...overrides,
  } as DispatchStateHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendSessionControl.mockResolvedValue({ ok: true });
});

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
        dispatch={makeDispatch()}
      />,
    );

    expect(screen.getByText("3時間前")).toBeTruthy();
    expect(screen.getByText(/入力を待っています/)).toBeTruthy();
  });

  it("様子の報告が無ければpollerが最後に見た時刻を添える", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);

    expect(screen.getByText("たった今")).toBeTruthy();
    expect(screen.getByText(/サブPCで実行中/)).toBeTruthy();
  });

  it("入力待ちのときだけRemote Controlの導線を出す", () => {
    render(
      <IssueSessionStatus
        session={session({
          activity: "WAITING_INPUT",
          activityAt: NOW.toISOString(),
          remoteControlUrl: "https://claude.ai/code/session_01ABC",
        })}
        dispatch={makeDispatch()}
      />,
    );

    expect(
      screen.getByRole("link", { name: /Remote Controlで開く/ }).getAttribute("href"),
    ).toBe("https://claude.ai/code/session_01ABC");
  });
});

/**
 * 画面からセッションを止める導線（#1332）。
 *
 * 見たいのは**押せる／押せないの判定が押す前に見えているか**で、実際にtmuxを叩くのは
 * サブPCのpoller。ここではAPIへ何を積んだかまでを確かめる。
 */
describe("IssueSessionStatus のセッション操作", () => {
  it("生きているセッションでは停止と終了を押せる", () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);

    expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "セッションを閉じる" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("停止を押すとそのセッションのホストへ積む", async () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() =>
      expect(sendSessionControl).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1353,
        hostName: "subpc",
        kind: "interrupt",
      }),
    );
  });

  // 畳むと戻せないため、閉じるだけ確認を挟む
  it("閉じるは確認してから積む", async () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッションを閉じる" }));

    expect(sendSessionControl).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "セッションを閉じる" }));

    await waitFor(() =>
      expect(sendSessionControl).toHaveBeenCalledWith(expect.objectContaining({ kind: "kill" })),
    );
  });

  // 古いpollerは`kind`を読まないため、押せてしまうと起動ジョブとして解釈される
  it("pollerが対応していないホストでは押せず、理由が出る", () => {
    render(
      <IssueSessionStatus
        session={session()}
        dispatch={makeDispatch({ hosts: [makeHost({ sessionControlCapable: null })] })}
      />,
    );

    expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/pollerがセッションの操作に対応していません/)).not.toBeNull();
  });

  // 終了したペインが残っているセッションは「閉じる」で片付けられる
  it("終了済みのセッションでは停止を出さない", () => {
    render(<IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />);

    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "セッションを閉じる" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("消えたセッションには操作を出さない", () => {
    render(<IssueSessionStatus session={session({ state: "GONE" })} dispatch={makeDispatch()} />);

    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByRole("button", { name: "セッションを閉じる" })).toBeNull();
  });

  // pull型なので、押した直後は何も起きない時間がある
  it("未処理の操作があれば送信済みと出し、重ねて押させない", () => {
    const job: DispatchJobView = {
      id: "job-1",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1353,
      targetHost: "subpc",
      kind: "INTERRUPT",
      status: "QUEUED",
      message: null,
      tmuxSessionName: "issue-deck-issue-1353",
      createdAt: "2026-08-14T00:06:00Z",
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
    };
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch({ jobs: [job] })} />);

    expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/停止を送信しました/)).not.toBeNull();
  });

  it("失敗の理由はその場に出す", async () => {
    sendSessionControl.mockResolvedValue({ ok: false, message: "サブPC が応答していません。" });
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(await screen.findByText("サブPC が応答していません。")).not.toBeNull();
  });
});
