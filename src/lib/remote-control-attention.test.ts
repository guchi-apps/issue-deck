import { describe, expect, it } from "vitest";

import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { shouldEmphasizeRemoteControl } from "@/lib/remote-control-attention";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    activity: "WORKING",
    activityAt: "2026-08-18T00:00:00Z",
    remoteControlUrl: "https://claude.ai/remote/abc",
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    firstSeenAt: "2026-08-18T00:00:00Z",
    lastReportedAt: "2026-08-18T00:00:00Z",
    ...overrides,
  };
}

function labels(...names: string[]) {
  return names.map((name) => ({ name }));
}

// #1964: 一覧で「押さないと先へ進まない行」を見分けられるようにする
describe("shouldEmphasizeRemoteControl", () => {
  /**
   * #2061: 計画への返事は画面から送れるようになったので、押す場所はアプリの中。
   * ここでRemote Controlを強調し続けると、行の中でオレンジが2つ並ぶうえ、
   * アプリで承認できること自体が画面から読み取れない。
   */
  it("計画への返事を画面から送れるなら、Remote Controlは強調しない", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("00.check-user", "01.check-plan", "11.local"),
        session: session({ activity: "WAITING_INPUT" }),
        planDecisionPending: true,
      }),
    ).toBe(false);
  });

  it("セッションが入力待ちなら強調する", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("11.local"),
        session: session({ activity: "WAITING_INPUT" }),
      }),
    ).toBe(true);
  });

  // 待つ相手がいない（`isSessionWaitingInput`が`ALIVE`を要求するのと同じ）
  it("終了したセッションの入力待ちでは強調しない", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("11.local"),
        session: session({ state: "EXITED", activity: "WAITING_INPUT" }),
      }),
    ).toBe(false);
  });

  it("動いているだけのセッションでは強調しない", () => {
    expect(shouldEmphasizeRemoteControl({ labels: labels("11.local"), session: session() })).toBe(
      false,
    );
  });

  it("00.check-userが付いていれば、入力待ちでなくても強調する", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("00.check-user", "01.check-plan", "11.local"),
        session: session(),
      }),
    ).toBe(true);
  });

  // マージはGitHub側の操作で、画面の対応PRから実行できる
  it("理由が01.check-mergeなら強調しない", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("00.check-user", "01.check-merge", "11.local"),
        session: session(),
      }),
    ).toBe(false);
  });

  // マージ待ちでもセッションが実際に入力を待っているなら、答える先はRemote Control
  it("理由が01.check-mergeでも、入力待ちなら強調する", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("00.check-user", "01.check-merge"),
        session: session({ activity: "WAITING_INPUT" }),
      }),
    ).toBe(true);
  });

  // 読むだけの状態で、片付ける場所はコメント欄の「確認待ちを外す」
  it("理由が01.check-answeredなら強調しない", () => {
    expect(
      shouldEmphasizeRemoteControl({
        labels: labels("00.check-user", "01.check-answered", "11.local"),
        session: session(),
      }),
    ).toBe(false);
  });

  // 理由ラベルが配られていないリポジトリ。何を待っているかは読めないが、待っているのは確か
  it("理由ラベルが無い00.check-userでも強調する", () => {
    expect(
      shouldEmphasizeRemoteControl({ labels: labels("00.check-user"), session: session() }),
    ).toBe(true);
  });

  it("セッションが無くても00.check-userだけで判定する", () => {
    expect(shouldEmphasizeRemoteControl({ labels: labels("00.check-user"), session: null })).toBe(
      true,
    );
    expect(shouldEmphasizeRemoteControl({ labels: [], session: null })).toBe(false);
  });
});
