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
    issueTitle: null,
    issueId: null,
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
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
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

  /**
   * #1557。ボタンの文言だけでは、押すまで「処理だけ止まる」のか「セッションごと終わる」のかが
   * 分からず、実際に問われた。**並んでいるときにしか迷いようがない**ので、停止を出している
   * ときだけ添える。
   */
  it("2つが並ぶときは違いを添える", () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);

    expect(screen.getByText(/今動いている処理だけを止めます/)).not.toBeNull();
    expect(screen.getByText(/セッションごと終了します/)).not.toBeNull();
  });

  it("停止を出さないセッションには違いの説明も出さない", () => {
    render(<IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />);

    expect(screen.queryByText(/今動いている処理だけを止めます/)).toBeNull();
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
      issueTitle: null,
      issueId: null,
      targetHost: "subpc",
      kind: "INTERRUPT",
      status: "QUEUED",
      queuePriority: 0,
      message: null,
      instruction: null,
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

  /**
   * #1012。人が書いた1行を走っているセッションへ流す。**本文を決めるのは人**で、
   * 画面が状況から組み立てて自動送信する経路は無い（docs/multi-agent/gates.md）。
   */
  describe("追加指示（#1012）", () => {
    function openForm() {
      fireEvent.click(screen.getByRole("button", { name: "追加指示を送る" }));
      return screen.getByLabelText("追加指示の本文") as HTMLInputElement;
    }

    it("書いた本文を送る", async () => {
      render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
      const input = openForm();
      fireEvent.change(input, { target: { value: "  計画を承認します。  " } });
      fireEvent.click(screen.getByRole("button", { name: "送信" }));

      await waitFor(() =>
        expect(sendSessionControl).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "instruction", instruction: "計画を承認します。" }),
        ),
      );
    });

    // 押した勢いでそのまま届くと、書き直す機会が無い
    it("定型文は差し込むだけで送らない", () => {
      render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
      const input = openForm();
      fireEvent.click(screen.getByRole("button", { name: /^計画を承認します/ }));

      expect(input.value).toContain("計画を承認します");
      expect(sendSessionControl).not.toHaveBeenCalled();
    });

    it("空の本文では送信できない", () => {
      render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
      openForm();

      expect(screen.getByRole("button", { name: "送信" }).hasAttribute("disabled")).toBe(true);
    });

    // 停止・終了に対応していても、内容のある文字列を送るのは別の実装
    it("追加指示に対応していないpollerでは押せず、理由が出る", () => {
      render(
        <IssueSessionStatus
          session={session()}
          dispatch={makeDispatch({ hosts: [makeHost({ instructionCapable: null })] })}
        />,
      );

      expect(
        screen.getByRole("button", { name: "追加指示を送る" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByText(/pollerが追加指示の送信に対応していません/)).not.toBeNull();
      // 停止・終了はそのまま押せる（申告が独立している）
      expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(false);
    });

    it("終了済みのセッションには出さない", () => {
      render(
        <IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />,
      );

      expect(screen.queryByRole("button", { name: "追加指示を送る" })).toBeNull();
    });

    // 見送りの理由はここにしか残らない（承認プロンプト表示中・打ちかけがある、など）
    it("pollerが見送った理由を画面に出す", () => {
      const job: DispatchJobView = {
        id: "job-2",
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1353,
        issueTitle: null,
        issueId: null,
        targetHost: "subpc",
        kind: "INSTRUCTION",
        status: "SKIPPED",
        queuePriority: 0,
        message: "承認プロンプトまたは選択フォームの表示中のため送りませんでした",
        instruction: "計画を承認します。",
        tmuxSessionName: "issue-deck-issue-1353",
        createdAt: "2026-08-14T00:06:00Z",
        claimedAt: null,
        startedAt: null,
        finishedAt: "2026-08-14T00:07:00Z",
      };
      render(<IssueSessionStatus session={session()} dispatch={makeDispatch({ jobs: [job] })} />);

      expect(screen.getByText(/送信を見送りました/)).not.toBeNull();
      expect(screen.getByText(/承認プロンプトまたは選択フォームの表示中/)).not.toBeNull();
    });
  });
});
