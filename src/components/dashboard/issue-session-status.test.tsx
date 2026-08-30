// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-08-14T12:00:00.000Z");

const sendSessionControl = vi.fn();
const requestCodexPairing = vi.fn();

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
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
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
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
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
    requestCodexPairing,
    cancel: vi.fn(),
    ...overrides,
  } as DispatchStateHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendSessionControl.mockResolvedValue({ ok: true });
  requestCodexPairing.mockResolvedValue({ ok: true });
});

/**
 * 操作は既定で畳まれている（#1676）。押せる／押せないを見るテストは、まず「操作」で開く。
 * 開く前に何が出ていないかは`describe("畳んだ状態（#1676）")`で確かめる。
 */
function openControls() {
  fireEvent.click(screen.getByRole("button", { name: /操作/ }));
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
        dispatch={makeDispatch()}
      />,
    );

    expect(screen.getByText("3時間前")).toBeTruthy();
    expect(screen.getByText(/サブPC・入力を待っています/)).toBeTruthy();
  });

  it("様子の報告が無ければpollerが最後に見た時刻を添える", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);

    expect(screen.getByText("たった今")).toBeTruthy();
    expect(screen.getByText(/サブPC・実行中/)).toBeTruthy();
  });

  /**
   * #1817。猶予待ちの数分間、画面には「応答を終えています」としか出ておらず、このまま消えるのか
   * 残るのかが読み取れなかった。**畳まずに出す**（次に何が起きるかは、押す気になったときだけ
   * 要る情報ではない）。
   */
  it("自動終了までの残り時間と理由を、畳まずに出す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <IssueSessionStatus
        session={session({
          activity: "RESPONDED",
          activityAt: NOW.toISOString(),
          reapAt: "2026-08-14T12:03:30.000Z",
          reapReason: "PR_MERGED",
        })}
        dispatch={makeDispatch()}
      />,
    );

    expect(screen.getByText("あと3分")).toBeTruthy();
    expect(screen.getByText(/PRがマージ済みのため/)).toBeTruthy();
  });

  it("畳む予定が無ければ残り時間を出さない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <IssueSessionStatus session={session({ activity: "RESPONDED" })} dispatch={makeDispatch()} />,
    );

    expect(screen.queryByText(/^あと\d+分$/)).toBeNull();
    expect(screen.queryByText("まもなく")).toBeNull();
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
    openControls();

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
    openControls();

    expect(screen.getByText(/今動いている処理だけを止めます/)).not.toBeNull();
    expect(screen.getByText(/セッションごと終了します/)).not.toBeNull();
  });

  it("停止を出さないセッションには違いの説明も出さない", () => {
    render(<IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />);
    openControls();

    expect(screen.queryByText(/今動いている処理だけを止めます/)).toBeNull();
  });

  it("停止を押すとそのセッションのホストへ積む", async () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);
    openControls();
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
    openControls();
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
    openControls();

    expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/pollerがセッションの操作に対応していません/)).not.toBeNull();
  });

  // 終了したペインが残っているセッションは「閉じる」で片付けられる
  it("終了済みのセッションでは停止を出さない", () => {
    render(<IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />);
    openControls();

    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "セッションを閉じる" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("消えたセッションには操作を出さない", () => {
    render(<IssueSessionStatus session={session({ state: "GONE" })} dispatch={makeDispatch()} />);

    // 畳む相手が1つも無いので、開くトグルごと出さない（#1676）
    expect(screen.queryByRole("button", { name: /操作/ })).toBeNull();
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
      agent: "claude",
      kind: "INTERRUPT",
      status: "QUEUED",
      queuePriority: 0,
      message: null,
      instruction: null,
      command: null,
      placeholderValues: null,
      resolvedCommand: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      codexPairingCode: null,
      codexPairingExpiresAt: null,
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
    openControls();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(await screen.findByText("サブPC が応答していません。")).not.toBeNull();
  });

  /**
   * #1012。人が書いた1行を走っているセッションへ流す。**本文を決めるのは人**で、
   * 画面が状況から組み立てて自動送信する経路は無い（docs/multi-agent/gates.md）。
   */
  describe("追加指示（#1012）", () => {
    function openForm() {
      openControls();
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
      openControls();

      expect(
        screen.getByRole("button", { name: "追加指示を送る" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByText(/pollerが追加指示の送信に対応していません/)).not.toBeNull();
      // 停止・終了はそのまま押せる（申告が独立している）
      expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(false);
    });

    /**
     * #2519。Codexのセッションへは`codex queue --thread <UUID>`で送るが、UUIDは
     * `SessionStart`フックからしか取れず、ディレクトリの信頼確認に答えるまで飛ばない。
     * **押せてしまうと、pollerが見送るまで何が起きたか分からない。**
     */
    it("Codexのセッションは宛先が分かるまで押せず、理由が出る", () => {
      render(
        <IssueSessionStatus
          session={session({ codexThreadKnown: false })}
          dispatch={makeDispatch()}
        />,
      );
      openControls();

      expect(
        screen.getByRole("button", { name: "追加指示を送る" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByText(/宛先がまだ分かりません/)).not.toBeNull();
      // 停止・終了はtmux側の操作なので宛先が要らない
      expect(screen.getByRole("button", { name: "停止" }).hasAttribute("disabled")).toBe(false);
    });

    // 届き方がClaude Codeと違う（走っているターンは止まらず、次のターンの頭に入る）
    it("Codexのセッションでは、届き方の説明が変わる", () => {
      render(
        <IssueSessionStatus
          session={session({ codexThreadKnown: true })}
          dispatch={makeDispatch()}
        />,
      );
      openForm();

      expect(screen.getByText(/次のターンの頭に届きます/)).not.toBeNull();
      expect(screen.queryByText(/承認プロンプトや選択フォームが出ている間/)).toBeNull();
    });

    it("終了済みのセッションには出さない", () => {
      render(
        <IssueSessionStatus session={session({ state: "EXITED" })} dispatch={makeDispatch()} />,
      );
      openControls();

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
        agent: "claude",
        kind: "INSTRUCTION",
        status: "SKIPPED",
        queuePriority: 0,
        message: "承認プロンプトまたは選択フォームの表示中のため送りませんでした",
        instruction: "計画を承認します。",
        command: null,
        placeholderValues: null,
        resolvedCommand: null,
        manualStepLine: null,
        targetJobId: null,
        previewAction: null,
        exitCode: null,
        commandOutput: null,
        codexPairingCode: null,
        codexPairingExpiresAt: null,
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

/**
 * #1676。スマホのIssue詳細では、このブロックだけで14行を占めてIssue本文が初期表示から
 * 押し出されていた。**畳むのは「押す気になったときだけ要るもの」に限る**ので、
 * 出口（Remote Control）と、押した操作の結果は畳まない。
 */
describe("IssueSessionStatus の畳んだ状態（#1676）", () => {
  function launchJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
    return {
      id: "job-launch",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1353,
      issueTitle: null,
      issueId: null,
      targetHost: "subpc",
      agent: "claude",
      kind: "LAUNCH",
      status: "SUCCEEDED",
      queuePriority: 0,
      message: null,
      instruction: null,
      command: null,
      placeholderValues: null,
      resolvedCommand: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      codexPairingCode: null,
      codexPairingExpiresAt: null,
      tmuxSessionName: "issue-deck-issue-1353",
      createdAt: "2026-08-14T00:06:00Z",
      claimedAt: null,
      startedAt: null,
      finishedAt: "2026-08-14T00:07:00Z",
      ...overrides,
    };
  }

  it("既定では停止・追加指示・閉じるを出さない", () => {
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch()} />);

    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByRole("button", { name: "追加指示を送る" })).toBeNull();
    expect(screen.queryByRole("button", { name: "セッションを閉じる" })).toBeNull();
    // 違いの説明（#1557）も、ボタンを見ているときにしか要らない
    expect(screen.queryByText(/今動いている処理だけを止めます/)).toBeNull();
    expect(screen.getByRole("button", { name: /操作/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  // 入力待ちのときRemote Controlが唯一の出口で、畳むと画面から`00.check-user`を外せない
  it("出口と次にやることは畳まない", () => {
    render(
      <IssueSessionStatus
        session={session({
          activity: "WAITING_INPUT",
          activityAt: NOW.toISOString(),
          remoteControlUrl: "https://claude.ai/code/session_01ABC",
          previewUrl: "http://subpc.example.ts.net:5676",
        })}
        dispatch={makeDispatch()}
      />,
    );

    expect(screen.getByRole("link", { name: /Remote Controlで開く/ })).not.toBeNull();
    expect(screen.getByRole("link", { name: /開発環境を開く/ })).not.toBeNull();
    expect(screen.getByText(/Remote Controlから答えてください/)).not.toBeNull();
  });

  // 押した直後に自分の操作が畳まれて見えなくなると、送り直してよいのか判断できない
  it("未処理の操作があるあいだは開いた状態で出す", () => {
    const job = launchJob({ id: "job-1", kind: "INTERRUPT", status: "QUEUED", finishedAt: null });
    render(<IssueSessionStatus session={session()} dispatch={makeDispatch({ jobs: [job] })} />);

    expect(screen.getByRole("button", { name: "停止" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /操作/ }).getAttribute("aria-expanded")).toBe("true");
  });

  // 起動ジョブの行（「サブPCで起動しました」）はこの行へ畳んでいる
  it("起動時刻とtmuxのコピーは展開したときに出す", () => {
    render(
      <IssueSessionStatus
        session={session()}
        dispatch={makeDispatch()}
        launchJob={launchJob()}
      />,
    );

    expect(screen.queryByText(/\d時\d+分に起動|\d+:\d+に起動/)).toBeNull();
    openControls();
    expect(screen.getByText(/\d時\d+分に起動|\d+:\d+に起動/)).not.toBeNull();
    expect(screen.getByRole("button", { name: /tmuxのコマンドをコピー/ })).not.toBeNull();
  });
});

/**
 * CodexのRemote Control相当（#2537）。**Codexのセッションでは`remoteControlUrl`が空**
 * （Codexが出すのはURLではなく10分で切れるペアリングコード。#2524）で、その導線は
 * 実行キューのホストのカードにしか無かった。入力待ちのCodexのセッションを開いても、
 * 画面から答える出口が1つも無いように見えていた。
 */
describe("IssueSessionStatus のCodexに繋ぐ（#2537）", () => {
  function pairingJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
    return {
      id: "job-pairing",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 0,
      issueTitle: null,
      issueId: null,
      targetHost: "subpc",
      agent: "claude",
      kind: "CODEX_PAIRING",
      status: "SUCCEEDED",
      queuePriority: 0,
      message: null,
      instruction: null,
      command: null,
      placeholderValues: null,
      resolvedCommand: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      codexPairingCode: null,
      codexPairingExpiresAt: null,
      tmuxSessionName: null,
      createdAt: "2026-08-14T11:59:00.000Z",
      claimedAt: null,
      startedAt: null,
      finishedAt: "2026-08-14T11:59:30.000Z",
      ...overrides,
    };
  }

  // Claude Codeのセッションには`Remote Controlで開く`があり、ペアリングコードは使わない
  it("Claude Codeのセッションには出さない", () => {
    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: null })}
        dispatch={makeDispatch({ hosts: [makeHost({ codexRemoteControlCapable: true })] })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Codexに繋ぐ" })).toBeNull();
  });

  it("走っているCodexのセッションでは押せる", async () => {
    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: true })}
        dispatch={makeDispatch({ hosts: [makeHost({ codexRemoteControlCapable: true })] })}
      />,
    );

    const button = screen.getByRole("button", { name: "Codexに繋ぐ" });
    expect(button.hasAttribute("disabled")).toBe(false);
    // **繋がる先はホスト単位。** 押したIssueだけに繋がると誤解させない
    expect(screen.getByText(/このIssueだけでなく/)).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(requestCodexPairing).toHaveBeenCalledWith("subpc"));
  });

  /**
   * ホストのカードとはここが違う（あちらは申告の無いホストには出さない）。Codexで
   * 動いていると分かっている行で黙って消すと、「Codexだけ対応していない」としか読めない。
   */
  it("standalone installを申告していないホストでは、理由を出して無効にする", () => {
    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: true })}
        dispatch={makeDispatch({
          hosts: [makeHost({ codexCapable: true, codexRemoteControlCapable: null })],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Codexに繋ぐ" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/standalone installのCodexが要ります/)).not.toBeNull();
  });

  // 終わったセッションはCodexのデーモンにも載っておらず、繋いでも見る相手がいない
  it("終わったセッションには出さない", () => {
    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: true, state: "EXITED" })}
        dispatch={makeDispatch({ hosts: [makeHost({ codexRemoteControlCapable: true })] })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Codexに繋ぐ" })).toBeNull();
  });

  // 発行されたコードは、押した人が別の端末へ打ち込むもの。残り時間も添える
  it("同じホストへ発行されたコードを出す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: true })}
        dispatch={makeDispatch({
          hosts: [makeHost({ codexRemoteControlCapable: true })],
          jobs: [
            pairingJob({
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(NOW.getTime() + 540_000).toISOString(),
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("A1B2-C3D4")).not.toBeNull();
    expect(screen.getByText("あと 9分00秒")).not.toBeNull();
  });

  // **コードは資格情報。** 期限を過ぎたものは画面に出さない（打ち込んでも通らない）
  it("期限の切れたコードは出さない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <IssueSessionStatus
        session={session({ codexThreadKnown: true })}
        dispatch={makeDispatch({
          hosts: [makeHost({ codexRemoteControlCapable: true })],
          jobs: [
            pairingJob({
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
            }),
          ],
        })}
      />,
    );

    expect(screen.queryByText("A1B2-C3D4")).toBeNull();
  });
});
