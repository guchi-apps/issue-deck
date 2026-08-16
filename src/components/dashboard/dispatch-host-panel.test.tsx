// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchHostPanel } from "@/components/dashboard/dispatch-host-panel";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
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
    checkout: null,
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
});
