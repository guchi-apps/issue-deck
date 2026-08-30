import { describe, expect, it } from "vitest";

import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";

describe("resolveCheckUserGuidance", () => {
  it("理由ラベルが読めなければnull（従来どおりの表示へ戻す）", () => {
    expect(resolveCheckUserGuidance({ reason: null, placement: "status" })).toBeNull();
  });

  it("計画の承認は、上部からは承認欄への移動を出す", () => {
    const guidance = resolveCheckUserGuidance({ reason: "plan", placement: "status" });
    expect(guidance?.heading).toBe("計画の承認が必要です");
    expect(guidance?.action).toEqual({ kind: "scroll", target: "approval" });
    expect(guidance?.buttons).toContain("コメント欄の「承認」");
    expect(guidance?.agentState).toBe("待機中");
  });

  it("承認カードの中では移動ボタンを出さず、押すボタン名だけを添える", () => {
    const guidance = resolveCheckUserGuidance({ reason: "plan", placement: "approval" });
    expect(guidance?.action).toBeNull();
    expect(guidance?.buttons).toContain("下の「承認」");
  });

  /**
   * #2061: 計画の承認・修正を画面から送れるようになったので、行き先はRemote Controlではなく
   * 同じ画面の計画パネル。ここを直さないと、アプリで承認できることが画面から読み取れない。
   */
  it("計画への返事を画面から送れるなら、計画パネルへ送る", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "plan",
      placement: "status",
      sessionWaitingInput: true,
      localSession: true,
      sessionAlive: true,
      remoteControlUrl: "https://claude.ai/remote/abc",
      planDecisionPending: true,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "plan" });
    expect(guidance?.buttons).toContain("承認して実装へ進む");
    expect(guidance?.description).not.toContain("Remote Control");
  });

  /** コメント欄の承認カードから見ても、目的地は上部のパネル（同じ場所ではない） */
  it("承認カードの中からでも、計画パネルへの移動ボタンを出す", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "plan",
      placement: "approval",
      planDecisionPending: true,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "plan" });
  });

  /** マージは待っているものが別（GitHub側の操作）。計画パネルへ送ってはいけない */
  it("マージ待ちは、計画の返事待ちがあっても対応PRへ送る", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "merge",
      placement: "status",
      planDecisionPending: true,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "pull-requests" });
  });

  it("マージは対応PRのセクションへ送る", () => {
    const guidance = resolveCheckUserGuidance({ reason: "merge", placement: "status" });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "pull-requests" });
    expect(guidance?.buttons).toContain("「マージ」");
  });

  /**
   * #2057。「修正を依頼する」はコメント欄の承認カードにしか無いボタンで、上部の案内が送る
   * 対応PRのセクションには置いていない。移動先に無いボタンを案内していた。
   */
  it("上部の案内は「修正を依頼する」に触れない（移動先にそのボタンが無い）", () => {
    const away = resolveCheckUserGuidance({ reason: "merge", placement: "status" });
    expect(away?.buttons).not.toContain("修正を依頼する");

    const here = resolveCheckUserGuidance({ reason: "merge", placement: "approval" });
    expect(here?.buttons).toContain("修正を依頼する");
  });

  it("対応PRのセクションが無いときは、押しても何も起きない移動先を出さない", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "merge",
      placement: "status",
      hasPullRequestSection: false,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "approval" });
  });

  it("セッションが入力待ちのときはRemote Controlへ寄せる", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "input",
      placement: "status",
      sessionWaitingInput: true,
      remoteControlUrl: "https://claude.ai/code/session_abc",
    });
    expect(guidance?.action).toEqual({
      kind: "remote-control",
      url: "https://claude.ai/code/session_abc",
    });
    expect(guidance?.description).toContain("Remote Control");
  });

  it("入力待ちでもRemote ControlのURLが無ければ、案内のある承認欄へ送る", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "input",
      placement: "status",
      sessionWaitingInput: true,
      remoteControlUrl: null,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "approval" });
  });

  it("Codexの入力待ちは端末から答える案内にする", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "input",
      placement: "status",
      sessionWaitingInput: true,
      implementationAgent: "codex",
    });
    expect(guidance?.description).toContain("端末から答えてください");
    expect(guidance?.description).not.toContain("Remote Control");
    expect(guidance?.buttons).not.toContain("Remote Control");
    expect(guidance?.action).toBeNull();
  });

  // マージはGitHub側の操作なので、`11.local`のセッションが入力待ちでも画面から実行できる
  it("入力待ちでもマージだけはRemote Controlへ寄せない", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "merge",
      placement: "status",
      sessionWaitingInput: true,
      remoteControlUrl: "https://claude.ai/code/session_abc",
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "pull-requests" });
  });

  // #1810。取得前の`sessions`は`[]`で、`sessionWaitingInput`は必ずfalseになる。そのまま
  // 描くと承認欄へ送る案内を出してからRemote Controlの案内へ書き換わる
  it("セッションの状態が届いていない間は、どちらの案内も出さない", () => {
    expect(
      resolveCheckUserGuidance({
        reason: "input",
        placement: "status",
        sessionWaitingInput: false,
        sessionStatePending: true,
      }),
    ).toBeNull();
  });

  it("セッションの状態が届けば、入力待ちの案内へ切り替わる", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "input",
      placement: "status",
      sessionWaitingInput: true,
      remoteControlUrl: "https://claude.ai/code/session_abc",
      sessionStatePending: false,
    });
    expect(guidance?.action).toEqual({
      kind: "remote-control",
      url: "https://claude.ai/code/session_abc",
    });
  });

  it("停止・回答済みは、待機中と区別できる状態を出す", () => {
    expect(resolveCheckUserGuidance({ reason: "blocked", placement: "status" })?.agentState).toBe(
      "停止中",
    );
    expect(
      resolveCheckUserGuidance({ reason: "answered", placement: "status" })?.agentState,
    ).toBe("待っていません");
  });

  /**
   * #1903。ローカルセッションが担当しているIssueでは、入力待ちで止まっていなくても
   * コメント欄はセッションへ届かない。「内容がエージェントへ渡ります」と言わせない。
   */
  it("ローカルが担当しているときは、エージェントへ渡ると案内しない", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "input",
      placement: "status",
      localSession: true,
      sessionAlive: true,
      remoteControlUrl: "https://claude.ai/code/session_abc",
    });
    expect(guidance?.buttons).not.toContain("エージェントへ渡ります");
    expect(guidance?.buttons).toContain("セッションには届かず");
    expect(guidance?.action).toEqual({
      kind: "remote-control",
      url: "https://claude.ai/code/session_abc",
    });
  });

  it("セッションが動いていなければ、起こし直しを促し承認欄へ送る", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "plan",
      placement: "status",
      localSession: true,
      sessionAlive: false,
      remoteControlUrl: null,
    });
    expect(guidance?.buttons).toContain("動いていません");
    expect(guidance?.action).toEqual({ kind: "scroll", target: "approval" });
  });

  it("ローカルでも、回答済みは「確認待ちを外す」を押すことだけを言う", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "answered",
      placement: "approval",
      localSession: true,
      sessionAlive: true,
    });
    expect(guidance?.buttons).toContain("「確認待ちを外す」");
    expect(guidance?.action).toBeNull();
  });

  // マージはGitHub側の操作なので、ローカルが担当していても画面から実行できる
  it("ローカルが担当していてもマージだけは従来どおり対応PRへ送る", () => {
    const guidance = resolveCheckUserGuidance({
      reason: "merge",
      placement: "status",
      localSession: true,
      sessionAlive: true,
    });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "pull-requests" });
    expect(guidance?.buttons).toContain("「マージ」");
  });
});
