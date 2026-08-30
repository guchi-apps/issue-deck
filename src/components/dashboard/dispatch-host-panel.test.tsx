// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompactHostCardSkeleton,
  DispatchHostPanel,
} from "@/components/dashboard/dispatch-host-panel";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-08-15T12:00:00.000Z");

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
    liveSessions: 2,
    metrics: {
      cpuPercent: 34,
      memoryUsedMb: 12_698,
      memoryTotalMb: 32_650,
      diskUsedGb: 219.4,
      diskTotalGb: 468.2,
      swapUsedMb: 1_024,
      swapTotalMb: 8_192,
    },
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function makeSelfUpdateJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    // Issueに紐づかないジョブなので、番号は埋め草の0（#1875）
    issueNumber: 0,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "SELF_UPDATE",
    status: "QUEUED",
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
    queuePriority: 0,
    createdAt: NOW.toISOString(),
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1567",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1567,
    issueTitle: "サブPC上のセッション表示とリソース使用率の表示機能",
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: NOW.toISOString(),
    lastReportedAt: NOW.toISOString(),
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    ...overrides,
  };
}

// 行に相対時刻（「たった今」）が入るため、現在時刻を固定しないと実行した日で結果が変わる
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("DispatchHostPanel", () => {
  it("申告しているホストが無ければ何も出さない", () => {
    const { container } = render(<DispatchHostPanel hosts={[]} sessions={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("ホスト名・セッション本数・使用率を出す", () => {
    render(<DispatchHostPanel hosts={[makeHost()]} sessions={[]} />);
    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByText("セッション 2/12")).toBeTruthy();
    expect(screen.getByText("34%")).toBeTruthy();
    expect(screen.getByText("39%・12.4 / 31.9 GB")).toBeTruthy();
    // SWAP（#1624）。メモリが埋まった後の余力はここにしか出ない
    expect(screen.getByText("13%・1.0 / 8.0 GB")).toBeTruthy();
    expect(screen.getByText("SWAP")).toBeTruthy();
  });

  // SWAPを持たないホスト・SWAPを申告しない古いpollerで0%のメーターを並べると、
  // 「SWAPが空いている」と「SWAPが無い」を見分けられない（#1624）
  it("SWAPが未申告のホストではSWAPの行を出さず、他の3つは出す", () => {
    render(
      <DispatchHostPanel
        hosts={[
          makeHost({
            metrics: {
              cpuPercent: 34,
              memoryUsedMb: 12_698,
              memoryTotalMb: 32_650,
              diskUsedGb: 219.4,
              diskTotalGb: 468.2,
              swapUsedMb: null,
              swapTotalMb: null,
            },
          }),
        ]}
        sessions={[]}
      />,
    );
    expect(screen.queryByText("SWAP")).toBeNull();
    expect(screen.getByText("34%")).toBeTruthy();
    expect(screen.getByText("39%・12.4 / 31.9 GB")).toBeTruthy();
  });

  // 従来は本数しか出ておらず、その中身は`tmux ls`かops-dashboardでしか見られなかった（#1567）
  it("動いているセッションを番号とタイトルで出す", () => {
    render(<DispatchHostPanel hosts={[makeHost()]} sessions={[makeSession()]} />);
    expect(screen.getByText("#1567 サブPC上のセッション表示とリソース使用率の表示機能")).toBeTruthy();
    expect(screen.getByText("issue-deck・実行中・たった今")).toBeTruthy();
  });

  // #1817。Issue詳細と同じ`describeSessionReap`を通す（同じ状態が画面によって違う言い方に
  // ならないようにする）。理由の1行はここには出さない（行が2倍になるため）
  it("自動終了までの残り時間を行の末尾に足す", () => {
    render(
      <DispatchHostPanel
        hosts={[makeHost()]}
        sessions={[
          makeSession({
            activity: "RESPONDED",
            activityAt: NOW.toISOString(),
            reapAt: new Date(NOW.getTime() + 3 * 60_000 + 30_000).toISOString(),
            reapReason: "HANDOFF_PR_OPEN",
          }),
        ]}
      />,
    );
    expect(screen.getByText("あと3分")).toBeTruthy();
    expect(screen.queryByText(/引き渡し済みのため/)).toBeNull();
  });

  it("タイトルが引けなければ番号だけを出す（穴埋めの文言を作らない）", () => {
    render(<DispatchHostPanel hosts={[makeHost()]} sessions={[makeSession({ issueTitle: null })]} />);
    expect(screen.getByText("#1567")).toBeTruthy();
  });

  // Issue詳細のセッション表示（issue-session-status.tsx）と同じ`summarizeIssueSession`を通す。
  // ここで独自の言い方を作ると、同じセッションが画面によって違う状態に見える
  it("入力待ちはその旨とRemote Controlへの導線を出す", () => {
    render(
      <DispatchHostPanel
        hosts={[makeHost()]}
        sessions={[
          makeSession({
            activity: "WAITING_INPUT",
            activityAt: NOW.toISOString(),
            remoteControlUrl: "https://claude.ai/code/session_1",
          }),
        ]}
      />,
    );
    expect(screen.getByText("issue-deck・入力を待っています・たった今")).toBeTruthy();
    expect(screen.getByLabelText("#1567のRemote Controlを開く")).toBeTruthy();
  });

  it("畳んだセッションは出さず、異常終了は出す", () => {
    render(
      <DispatchHostPanel
        hosts={[makeHost()]}
        sessions={[
          makeSession({ tmuxSessionName: "a", issueNumber: 1, issueTitle: null, state: "EXITED" }),
          makeSession({
            tmuxSessionName: "b",
            issueNumber: 2,
            issueTitle: null,
            state: "FAILED",
            exitStatus: 1,
          }),
        ]}
      />,
    );
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("issue-deck・異常終了・たった今")).toBeTruthy();
  });

  // 0%として並べると、実際には埋まっているホストが空いているように見える
  it("応答していないホストでは使用率も本数も出さず、最後の申告を出す", () => {
    render(<DispatchHostPanel hosts={[makeHost({ online: false })]} sessions={[]} />);
    expect(screen.queryByText("34%")).toBeNull();
    expect(screen.queryByText("セッション 2/12")).toBeNull();
    expect(screen.getByText(/応答していません/)).toBeTruthy();
  });

  /**
   * #1612。**pollerは自分と同じチェックアウトの回収スクリプト・ランチャーを動かす**ため、
   * developへマージしただけでは効かない。効いていないことに気付く手掛かりがどこにも無く、
   * 実際に97コミット遅れたまま#1454・#1541が一度も働いていなかった。
   */
  it("動かしているスクリプトの版と、developからの遅れを出す", () => {
    render(
      <DispatchHostPanel
        hosts={[
          makeHost({
            checkout: {
              commit: "fbb809d",
              branch: "develop",
              committedAt: NOW.toISOString(),
              behindCount: 97,
              fetchedAt: NOW.toISOString(),
            },
          }),
        ]}
        sessions={[]}
      />,
    );
    expect(screen.getByText("スクリプト develop fbb809d")).toBeTruthy();
    expect(screen.getByText("97コミット遅れ・たった今")).toBeTruthy();
  });

  it("版を申告していない古いpollerではその行を出さない", () => {
    render(<DispatchHostPanel hosts={[makeHost()]} sessions={[]} />);
    expect(screen.queryByText(/スクリプト/)).toBeNull();
  });

  it("使用率を申告していない古いpollerではメーターを出さない", () => {
    render(<DispatchHostPanel hosts={[makeHost({ metrics: null })]} sessions={[]} />);
    expect(screen.queryByText("34%")).toBeNull();
    expect(screen.getByText("セッション 2/12")).toBeTruthy();
  });

  // 画面に出ているIssueを開くのに、一覧へ戻って番号で探し直す必要があった（#1625）
  it("Issueのidが引けていれば、タイトルを押してそのIssueを開ける", () => {
    const onOpenIssue = vi.fn();
    render(
      <DispatchHostPanel
        hosts={[makeHost()]}
        sessions={[makeSession({ issueId: "issue-1567" })]}
        onOpenIssue={onOpenIssue}
      />,
    );

    const button = screen.getByLabelText(
      "#1567 サブPC上のセッション表示とリソース使用率の表示機能をissue-deckで開く",
    );
    button.click();
    expect(onOpenIssue).toHaveBeenCalledWith("issue-1567");
  });

  // 同期前・GitHub Appを外したリポジトリではidが引けない。押しても何も起きないリンクは出さない
  it("Issueのidが引けていない行はリンクにしない", () => {
    const onOpenIssue = vi.fn();
    render(
      <DispatchHostPanel
        hosts={[makeHost()]}
        sessions={[makeSession({ issueId: null })]}
        onOpenIssue={onOpenIssue}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("#1567 サブPC上のセッション表示とリソース使用率の表示機能")).toBeTruthy();
  });

  // スマホのホーム画面など、遷移先を持たない置き方でも表示だけは従来どおり出す
  it("遷移の受け取り手が無ければタイトルはただの文字列のまま", () => {
    render(
      <DispatchHostPanel hosts={[makeHost()]} sessions={[makeSession({ issueId: "issue-1567" })]} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ホストが2台以上なら、それぞれのセッションを自分のカードの下に出す", () => {
    render(
      <DispatchHostPanel
        hosts={[makeHost(), makeHost({ name: "mainpc", metrics: null })]}
        sessions={[
          makeSession({ tmuxSessionName: "a", issueNumber: 1, issueTitle: null }),
          makeSession({ tmuxSessionName: "b", issueNumber: 2, issueTitle: null, host: "mainpc" }),
        ]}
      />,
    );
    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByText("mainpc")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
  });

  // 縮めた版（#1933）。スマホのホームだけがこれを使う
  describe("compact（#1933）", () => {
    it("使用率を横並びの4列で出し、実数は落とす", () => {
      const { container } = render(<DispatchHostPanel hosts={[makeHost()]} sessions={[]} compact />);

      expect(container.querySelector(".grid-cols-4")).toBeTruthy();
      expect(screen.getByText("34%")).toBeTruthy();
      // 実数（`39%・12.4 / 31.9 GB`）は4列に入れると読める字幅にならないので割合だけにする
      expect(screen.getByText("39%")).toBeTruthy();
      expect(screen.queryByText("39%・12.4 / 31.9 GB")).toBeNull();
      expect(screen.getByText("セッション 2/12")).toBeTruthy();
    });

    it("SWAPが未申告のホストでは3列にする（0%の枠を置かない）", () => {
      const { container } = render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              metrics: {
                cpuPercent: 34,
                memoryUsedMb: 12_698,
                memoryTotalMb: 32_650,
                diskUsedGb: 219.4,
                diskTotalGb: 468.2,
                swapUsedMb: null,
                swapTotalMb: null,
              },
            }),
          ]}
          sessions={[]}
          compact
        />,
      );

      expect(container.querySelector(".grid-cols-3")).toBeTruthy();
      expect(screen.queryByText("SWAP")).toBeNull();
    });

    // 同じ一覧をヘッダーの実行状況シートが持っているので、ホームには出さない（#1933）
    it("動いているセッションを出さない", () => {
      render(<DispatchHostPanel hosts={[makeHost()]} sessions={[makeSession()]} compact />);

      expect(
        screen.queryByText("#1567 サブPC上のセッション表示とリソース使用率の表示機能"),
      ).toBeNull();
    });

    /**
     * 一覧を落とすと、シートを開くべきときを示すものがホームから消える（本数は本数でしかなく、
     * ホームの「実行中」はIssueの件数）。入力待ちだけは見出しに残す
     */
    it("入力待ちのセッションがあれば本数を見出しに残す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost()]}
          sessions={[
            makeSession({ tmuxSessionName: "a", activity: "WAITING_INPUT", activityAt: NOW.toISOString() }),
            makeSession({ tmuxSessionName: "b" }),
          ]}
          compact
        />,
      );

      expect(screen.getByText("入力待ち 1")).toBeTruthy();
    });

    it("入力待ちが無ければ印を出さない", () => {
      render(<DispatchHostPanel hosts={[makeHost()]} sessions={[makeSession()]} compact />);

      expect(screen.queryByText(/入力待ち/)).toBeNull();
    });

    it("スクリプトの版は遅れているときだけ出す", () => {
      const latest = render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              checkout: {
                commit: "fbb809d",
                branch: "develop",
                committedAt: NOW.toISOString(),
                behindCount: 0,
                fetchedAt: NOW.toISOString(),
              },
            }),
          ]}
          sessions={[]}
          compact
        />,
      );
      expect(screen.queryByText(/スクリプト/)).toBeNull();
      latest.unmount();

      render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              checkout: {
                commit: "fbb809d",
                branch: "develop",
                committedAt: NOW.toISOString(),
                behindCount: 97,
                fetchedAt: NOW.toISOString(),
              },
            }),
          ]}
          sessions={[]}
          compact
        />,
      );
      expect(screen.getByText("スクリプト develop fbb809d")).toBeTruthy();
      expect(screen.getByText("97コミット遅れ")).toBeTruthy();
    });

    it("受け取り手を渡すと、カード全体が実行状況を開くボタンになる", () => {
      const onOpenDetail = vi.fn();
      render(
        <DispatchHostPanel
          hosts={[makeHost()]}
          sessions={[]}
          compact
          onOpenDetail={onOpenDetail}
        />,
      );

      screen.getByRole("button", { name: "サブPCの実行状況を開く" }).click();
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
    });

    // 「更新して再起動」はシート側の担当（カード全体がボタンなので中にボタンを重ねられない）
    it("遅れていても更新のボタンは出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              selfUpdateCapable: true,
              previewCapable: null,
              rebootCapable: null,
              reboot: null,
              previewRepositories: null,
              preview: null,
              checkout: {
                commit: "7b71764",
                branch: "develop",
                committedAt: NOW.toISOString(),
                behindCount: 31,
                fetchedAt: NOW.toISOString(),
              },
            }),
          ]}
          sessions={[]}
          compact
          onRequestSelfUpdate={vi.fn()}
          onOpenDetail={() => {}}
        />,
      );

      expect(screen.queryByRole("button", { name: "更新して再起動" })).toBeNull();
    });
  });

  /**
   * 取得できるまでのあいだ、縮めた版と同じ高さで場所を取るスケルトン（#2090）。
   * **高さが揃っていることがこの部品の目的**なので、実物と同じ組み方で描けているかを見る。
   */
  describe("CompactHostCardSkeleton（#2090）", () => {
    /**
     * **高さを決めているクラスが実物と1つずつ一致することを見る。**
     * 縮めた版の高さは固定値ではなく、文字サイズ（`text-xs`・`text-[10px]`など＝行の高さ）と
     * 余白（`p-2`・`mt-2`・`gap-*`・`h-1`）の積み上げで決まる。片方だけを直すと、
     * 見た目には気付かないまま差し替えの瞬間に行が動くので、ここで並べて突き合わせる。
     */
    it("高さを決めるクラスが実物と一致する", () => {
      const HEIGHT_CLASS =
        /^(?:text-(?:xs|sm|base|\[[\d.]+px\])|mt-\d|p-\d|gap-[\d.]+|size-[\d.]+|h-\d)$/;
      // 数えるのはカード1枚の中だけ。`DispatchHostPanel`が複数枚を縦に積むための
      // `gap-2`はカードの外側の話で、1枚しか描かないスケルトンには無くてよい
      const cardOf = (container: Element) => {
        const card = container.querySelector(".rounded-md.border.p-2");
        if (!card) throw new Error("カードが見つからない");
        return card;
      };
      const collect = (card: Element) =>
        [card, ...Array.from(card.querySelectorAll<HTMLElement>("*"))]
          .flatMap((el) => Array.from(el.classList))
          .filter((name) => HEIGHT_CLASS.test(name))
          .sort();

      // 山括弧（`size-3.5`）は`onOpenDetail`を渡したときだけ付く飾りで、行の高さ
      // （`text-[11px]`の16.5px）より小さい。突き合わせの邪魔になるので渡さずに描く
      const real = render(<DispatchHostPanel hosts={[makeHost()]} sessions={[]} compact />);
      const realClasses = collect(cardOf(real.container));
      real.unmount();

      const { container } = render(<CompactHostCardSkeleton />);

      expect(collect(cardOf(container))).toEqual(realClasses);
      expect(realClasses.length).toBeGreaterThan(0);
    });

    it("中身は読み上げず、読み込み中であることだけを渡す", () => {
      render(<CompactHostCardSkeleton />);

      expect(screen.getByRole("status").textContent).toBe("サブPCの状態を読み込み中");
      // 帯の下に敷いた文字（`サブPC`・`CPU`など）は幅を実物へ合わせるためだけのものなので、
      // まとめて`aria-hidden`の中へ入れる
      expect(screen.getByText("CPU").closest("[aria-hidden]")).toBeTruthy();
      expect(screen.getByText("サブPC").closest("[aria-hidden]")).toBeTruthy();
    });
  });

  /**
   * #1875で入れたボタンは、押しても画面に何も出なかった（#1927）。積めなかった理由も、
   * pollerが返した失敗も捨てられており、`SELF_UPDATE`は実行キューの一覧にも出ないため、
   * 「反応しない」以外の見え方が無かった。
   */
  describe("更新して再起動（#1875・#1927）", () => {
    const BEHIND = makeHost({
      selfUpdateCapable: true,
      previewCapable: null,
      rebootCapable: null,
      reboot: null,
      previewRepositories: null,
      preview: null,
      checkout: {
        commit: "7b71764",
        branch: "develop",
        committedAt: NOW.toISOString(),
        behindCount: 31,
        fetchedAt: NOW.toISOString(),
      },
    });

    it("押すとホスト名を渡して更新を積む", async () => {
      const onRequestSelfUpdate = vi.fn().mockResolvedValue({ ok: true });
      render(
        <DispatchHostPanel
          hosts={[BEHIND]}
          sessions={[]}
          onRequestSelfUpdate={onRequestSelfUpdate}
        />,
      );

      await act(async () => {
        screen.getByRole("button", { name: "更新して再起動" }).click();
      });
      expect(onRequestSelfUpdate).toHaveBeenCalledWith("subpc");
    });

    it("積めなかった理由をボタンの下に出す", async () => {
      const onRequestSelfUpdate = vi
        .fn()
        .mockResolvedValue({ ok: false, message: "subpc の更新は既に積まれています。" });
      render(
        <DispatchHostPanel
          hosts={[BEHIND]}
          sessions={[]}
          onRequestSelfUpdate={onRequestSelfUpdate}
        />,
      );

      await act(async () => {
        screen.getByRole("button", { name: "更新して再起動" }).click();
      });
      expect(screen.getByText("subpc の更新は既に積まれています。")).toBeTruthy();
    });

    // pull型で届くまで数秒〜30秒あり、その間に何も出ないと押し直される
    it("積んだ更新が届くまでの間はその旨を出し、押せなくする", () => {
      render(
        <DispatchHostPanel
          hosts={[BEHIND]}
          sessions={[]}
          jobs={[makeSelfUpdateJob()]}
          onRequestSelfUpdate={vi.fn()}
        />,
      );

      expect(screen.getByText("更新を積みました（届くまで数秒〜30秒）")).toBeTruthy();
      expect(screen.getByRole("button", { name: "更新して再起動" }).hasAttribute("disabled")).toBe(
        true,
      );
    });

    // 届いた後の失敗はpollerからしか返らない。ここに出さないと画面のどこにも出ない
    it("pollerが返した失敗の理由を出す", () => {
      render(
        <DispatchHostPanel
          hosts={[BEHIND]}
          sessions={[]}
          jobs={[
            makeSelfUpdateJob({
              status: "FAILED",
              message: "作業ツリーに未コミットの変更があります。手元で確認してください。",
              finishedAt: NOW.toISOString(),
            }),
          ]}
          onRequestSelfUpdate={vi.fn()}
        />,
      );

      expect(
        screen.getByText(
          "更新できませんでした: 作業ツリーに未コミットの変更があります。手元で確認してください。",
        ),
      ).toBeTruthy();
    });

    // 更新に成功すると遅れは0になるが、そこでボタンごと消すと押した結果が読めないまま終わる
    it("遅れが解消していても、直前の更新の結果は出す", () => {
      render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              selfUpdateCapable: true,
              previewCapable: null,
              rebootCapable: null,
              reboot: null,
              previewRepositories: null,
              preview: null,
              checkout: {
                commit: "fbb809d",
                branch: "develop",
                committedAt: NOW.toISOString(),
                behindCount: 0,
                fetchedAt: NOW.toISOString(),
              },
            }),
          ]}
          sessions={[]}
          jobs={[
            makeSelfUpdateJob({
              status: "SUCCEEDED",
              message: "7b71764 → fbb809d へ更新しました。再起動します。",
              finishedAt: NOW.toISOString(),
            }),
          ]}
          onRequestSelfUpdate={vi.fn()}
        />,
      );

      expect(screen.getByText("7b71764 → fbb809d へ更新しました。再起動します。")).toBeTruthy();
    });

    it("遅れておらず積んだ更新も無ければボタンを出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              selfUpdateCapable: true,
              previewCapable: null,
              rebootCapable: null,
              reboot: null,
              previewRepositories: null,
              preview: null,
              checkout: {
                commit: "fbb809d",
                branch: "develop",
                committedAt: NOW.toISOString(),
                behindCount: 0,
                fetchedAt: NOW.toISOString(),
              },
            }),
          ]}
          sessions={[]}
          onRequestSelfUpdate={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: "更新して再起動" })).toBeNull();
    });

    // 申告していないpollerへ配っても、未知の種別として失敗するだけ
    it("更新に対応していないpollerには出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ selfUpdateCapable: null, checkout: BEHIND.checkout })]}
          sessions={[]}
          onRequestSelfUpdate={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: "更新して再起動" })).toBeNull();
    });
  });
  describe("ホストごとの再起動（#2496）", () => {
    /** 再起動が要る（`/var/run/reboot-required`が立っている）ホスト */
    const NEEDS_REBOOT = makeHost({
      rebootCapable: true,
      liveSessions: 0,
      reboot: {
        required: true,
        requiredSince: new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        bootedAt: new Date(NOW.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });

    function rebootJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
      return makeSelfUpdateJob({ id: "reboot-1", kind: "REBOOT", ...overrides });
    }

    it("確認を挟んでから、ホスト名を渡して積む", async () => {
      const onRequestReboot = vi.fn().mockResolvedValue({ ok: true });
      render(
        <DispatchHostPanel
          hosts={[NEEDS_REBOOT]}
          sessions={[]}
          onRequestReboot={onRequestReboot}
        />,
      );

      // いつから落としていないか・なぜ落とすのかが行に出る
      expect(screen.getByText("再起動 稼働 13日")).toBeTruthy();

      await act(async () => {
        screen.getByRole("button", { name: "再起動する" }).click();
      });
      // **押し間違えても戻せない操作なので、1回目の押下では積まない**
      expect(onRequestReboot).not.toHaveBeenCalled();
      expect(screen.getByText(/OSごと落とします/)).toBeTruthy();

      await act(async () => {
        screen.getByRole("button", { name: "再起動する" }).click();
      });
      expect(onRequestReboot).toHaveBeenCalledWith("subpc");
    });

    it("セッションが走っていれば押せず、理由をボタンの下に出す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ ...NEEDS_REBOOT, liveSessions: 3 })]}
          sessions={[]}
          onRequestReboot={vi.fn()}
        />,
      );

      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "再起動する" }).disabled,
      ).toBe(true);
      expect(screen.getByText(/セッションが走っている間は押せません/)).toBeTruthy();
    });

    it("積めなかった理由をボタンの下に出す", async () => {
      const onRequestReboot = vi
        .fn()
        .mockResolvedValue({ ok: false, message: "subpc の再起動は既に積まれています。" });
      render(
        <DispatchHostPanel
          hosts={[NEEDS_REBOOT]}
          sessions={[]}
          onRequestReboot={onRequestReboot}
        />,
      );

      await act(async () => {
        screen.getByRole("button", { name: "再起動する" }).click();
      });
      await act(async () => {
        screen.getByRole("button", { name: "再起動する" }).click();
      });
      expect(screen.getByText("subpc の再起動は既に積まれています。")).toBeTruthy();
    });

    // **`REBOOT`は実行キューの一覧に出ない**（起動ジョブでも制御ジョブでもない）。
    // ここに出さないと、pollerが返した失敗が画面のどこにも現れない（#1927と同じ罠）
    it("pollerが返した失敗をボタンの下に出す", () => {
      render(
        <DispatchHostPanel
          hosts={[NEEDS_REBOOT]}
          sessions={[]}
          jobs={[
            rebootJob({
              status: "FAILED",
              message: "セッションが2本走っています。",
              finishedAt: NOW.toISOString(),
            }),
          ]}
          onRequestReboot={vi.fn()}
        />,
      );

      expect(screen.getByText(/セッションが2本走っています。/)).toBeTruthy();
    });

    it("積んだ後は押し直させず、起動を止めていることを出す", () => {
      render(
        <DispatchHostPanel
          hosts={[NEEDS_REBOOT]}
          sessions={[]}
          jobs={[rebootJob()]}
          onRequestReboot={vi.fn()}
        />,
      );

      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "再起動する" }).disabled,
      ).toBe(true);
      expect(screen.getByText(/新しいセッションの起動を止めています/)).toBeTruthy();
    });

    // **落とす理由が無いときに、取り返しのつかないボタンを並べ続けない**（#52の結論とも揃う）
    it("再起動が要らないホストにはボタンを出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[
            makeHost({
              ...NEEDS_REBOOT,
              reboot: { required: false, requiredSince: null, bootedAt: NOW.toISOString() },
            }),
          ]}
          sessions={[]}
          onRequestReboot={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: "再起動する" })).toBeNull();
    });

    it("対応していないpollerにはボタンを出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ ...NEEDS_REBOOT, rebootCapable: null })]}
          sessions={[]}
          onRequestReboot={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: "再起動する" })).toBeNull();
    });
  });

  describe("メモリ・SWAPの逼迫による起動の見送り（#2095）", () => {
    const HOLD = { reason: "MEMORY", percent: 92.3, thresholdPercent: 85 } as const;

    it("見送っていることと、判断に使った使用率を出す", () => {
      render(<DispatchHostPanel hosts={[makeHost({ launchHold: HOLD })]} sessions={[]} />);

      expect(
        screen.getByText("メモリ 92%（上限 85%）のため、新しいセッションの起動を見送っています"),
      ).toBeTruthy();
    });

    // ホームで「実行中」が増えないことに気付くのがいちばん早く、そこに理由が無いと
    // 結局サブPCを見に行くことになる
    it("縮めた版（スマホのホーム）にも出す", () => {
      render(<DispatchHostPanel hosts={[makeHost({ launchHold: HOLD })]} sessions={[]} compact />);

      expect(
        screen.getByText("メモリ 92%（上限 85%）のため、新しいセッションの起動を見送っています"),
      ).toBeTruthy();
    });

    it("見送っていなければ何も出さない", () => {
      render(<DispatchHostPanel hosts={[makeHost()]} sessions={[]} />);

      expect(screen.queryByText(/起動を見送っています/)).toBeNull();
    });
  });
  // #2524。CodexにはClaude CodeのようなRemote ControlのURLが無く、押して発行する
  // `XXXX-XXXX`のペアリングコードだけが出口になる
  describe("CodexのRemote Control相当（#2524）", () => {
    function pairingJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
      return makeSelfUpdateJob({ id: "pairing", kind: "CODEX_PAIRING", ...overrides });
    }

    it("standalone installを申告したホストにだけボタンを出す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.getByRole("button", { name: "Codexに繋ぐ" })).toBeTruthy();
    });

    // `codex`コマンドがあるだけでは`remote-control`が動かない（#2521）。押せるように見せると、
    // 押した人には「押しても失敗する」しか残らない
    it("`codexCapable`だけのホストには出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexCapable: true, codexRemoteControlCapable: null })]}
          sessions={[]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.queryByRole("button", { name: "Codexに繋ぐ" })).toBeNull();
    });

    it("繋がる先がホストごとであることを、押す前に出す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.getByText(/のCodexセッション全部に繋がります/)).toBeTruthy();
    });

    it("発行されたコードと残り時間を出す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          jobs={[
            pairingJob({
              status: "SUCCEEDED",
              finishedAt: NOW.toISOString(),
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(NOW.getTime() + 540_000).toISOString(),
            }),
          ]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.getByText("A1B2-C3D4")).toBeTruthy();
      expect(screen.getByText("あと 9分00秒")).toBeTruthy();
    });

    // 期限（10分）を過ぎたコードを出し続けると、押した人は効かないコードを打ち込むことになる
    it("切れたコードは出さない", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          jobs={[
            pairingJob({
              status: "SUCCEEDED",
              finishedAt: NOW.toISOString(),
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
            }),
          ]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.queryByText("A1B2-C3D4")).toBeNull();
    });

    // ジョブが終わるとキューのポーリングは20秒間隔へ落ちる。残り時間をそれに任せると
    // カウントダウンが20秒刻みで飛び、切れたコードが最大20秒残る
    it("ポーリングを待たずに、残り時間を1秒ごとに数え直す", async () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          jobs={[
            pairingJob({
              status: "SUCCEEDED",
              finishedAt: NOW.toISOString(),
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(NOW.getTime() + 65_000).toISOString(),
            }),
          ]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.getByText("あと 1分05秒")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText("あと 55秒")).toBeTruthy();

      // 期限が来たら、同じ props のまま行ごと消える
      await act(async () => {
        await vi.advanceTimersByTimeAsync(56_000);
      });
      expect(screen.queryByText("A1B2-C3D4")).toBeNull();
    });

    it("失敗の理由をボタンの下に出す", () => {
      render(
        <DispatchHostPanel
          hosts={[makeHost({ codexRemoteControlCapable: true })]}
          sessions={[]}
          jobs={[
            pairingJob({
              status: "FAILED",
              finishedAt: NOW.toISOString(),
              message: "Codexのデーモンを起動できませんでした（終了コード 1）。",
            }),
          ]}
          onRequestCodexPairing={async () => ({ ok: true })}
        />,
      );

      expect(screen.getByText(/Codexのデーモンを起動できませんでした/)).toBeTruthy();
    });

    // 渡さなければ出さない（`onRequestSelfUpdate`・`onRequestReboot`と同じ形）
    it("受け取り手が無ければ出さない", () => {
      render(
        <DispatchHostPanel hosts={[makeHost({ codexRemoteControlCapable: true })]} sessions={[]} />,
      );

      expect(screen.queryByRole("button", { name: "Codexに繋ぐ" })).toBeNull();
    });
  });
});
