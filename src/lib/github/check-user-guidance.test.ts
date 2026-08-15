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
    expect(guidance?.agentState.tag).toBe("待機中");
  });

  it("承認カードの中では移動ボタンを出さず、押すボタン名だけを添える", () => {
    const guidance = resolveCheckUserGuidance({ reason: "plan", placement: "approval" });
    expect(guidance?.action).toBeNull();
    expect(guidance?.buttons).toContain("下の「承認」");
  });

  it("マージは対応PRのセクションへ送る", () => {
    const guidance = resolveCheckUserGuidance({ reason: "merge", placement: "status" });
    expect(guidance?.action).toEqual({ kind: "scroll", target: "pull-requests" });
    expect(guidance?.buttons).toContain("「マージ」");
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

  it("停止・回答済みは、待機中と区別できる状態を出す", () => {
    expect(resolveCheckUserGuidance({ reason: "blocked", placement: "status" })?.agentState.tag).toBe(
      "停止中",
    );
    expect(
      resolveCheckUserGuidance({ reason: "answered", placement: "status" })?.agentState.tag,
    ).toBe("待っていません");
  });
});
