import { describe, expect, it } from "vitest";

import {
  buildSessionInterruptedCommentBody,
  buildSessionNotStartedCommentBody,
} from "@/lib/dispatch/session-escalation";

/**
 * #1465・#1838。フォルダの信頼確認で止まったときにIssueへ出す案内。
 *
 * **「答えられるのは端末だけ」だけでは足りない**（#1838）。次に新しいリポジトリを起こしたときに
 * また同じ足止めに遭うため、恒久的な直し方（リポジトリにつき1回だけ答えておく）まで書く。
 */
describe("buildSessionNotStartedCommentBody", () => {
  const body = buildSessionNotStartedCommentBody({
    hostName: "subpc",
    tmuxSessionName: "car-care-issue-27",
  });

  it("端末から答える手順を出す（Remote Controlは繋がっていない）", () => {
    expect(body).toContain("tmux attach -t car-care-issue-27");
    expect(body).toContain("Remote Controlから答えられません");
  });

  it("リポジトリにつき1回で済むことと、先に答えておく手順を出す", () => {
    expect(body).toContain("**リポジトリにつき1回**");
    expect(body).toContain("claude");
  });

  it("答えてもプロンプトが失われることがある点に触れる", () => {
    expect(body).toContain("答えても何も始まらない場合");
  });
});

/**
 * #1971・#2280。APIエラーで中断したまま止まったときにIssueへ出す案内。
 *
 * **かつてはSignalyへの通知だけが宛先で、Issueには何も残らなかった。** webhookを消したので、
 * 異常終了・起動確認での足止めと同じくコメントとして残す。載せてよいのはpollerが持つ固定の
 * 文言（`detail`）までで、セッションの画面も応答テキストも載せない。
 */
describe("buildSessionInterruptedCommentBody", () => {
  const body = buildSessionInterruptedCommentBody({
    hostName: "subpc",
    tmuxSessionName: "issue-deck-issue-2280",
    detail: "3回試しましたが復帰しませんでした",
    remoteControlUrl: "https://claude.ai/code/session_01ABC",
  });

  it("続きを人が引き取るための出口を両方出す", () => {
    expect(body).toContain("tmux attach -t issue-deck-issue-2280");
    expect(body).toContain("https://claude.ai/code/session_01ABC");
  });

  it("pollerが渡した状況を載せる", () => {
    expect(body).toContain("3回試しましたが復帰しませんでした");
  });

  // 中断は「答えれば済む」ものではないので、`Stop`で勝手に外れない旨まで書く
  it("00.check-userが自動では外れないことを書く", () => {
    expect(body).toContain("自動では外れません");
  });

  it("省略できる項目が無くても本文が壊れない", () => {
    const minimal = buildSessionInterruptedCommentBody({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-2280",
      detail: null,
      remoteControlUrl: null,
    });
    expect(minimal).toContain("tmux attach -t issue-deck-issue-2280");
    expect(minimal).not.toContain("- 状況:");
    expect(minimal).not.toContain("Remote Controlから続けてください");
  });

  it("reasonを省略するとAPIエラーの文言になる（#1971からの後方互換）", () => {
    expect(body).toContain("APIエラーで中断したまま止まっています");
  });
});

/**
 * #2655。「ツールを呼び出したつもりでテキストに書いただけで、実際には呼ばれていない」まま
 * 停滞したときにIssueへ出す案内。文言だけが`api_error`と違い、出口の構造（tmux attach・
 * Remote Control・00.check-userが自動で外れない旨）は共通にする。
 */
describe("buildSessionInterruptedCommentBody（reason: tool_call_stall）", () => {
  const body = buildSessionInterruptedCommentBody({
    hostName: "subpc",
    tmuxSessionName: "research-desk-issue-41",
    detail: "直前の応答でツールを呼び出そうとした形跡がありますが、実際には呼び出されていません。",
    remoteControlUrl: "https://claude.ai/code/session_01XYZ",
    reason: "tool_call_stall",
  });

  it("APIエラーではなく、テキストとして書かれただけという原因を説明する", () => {
    expect(body).toContain("実際には");
    expect(body).toContain("呼び出されないまま停滞しています");
    expect(body).not.toContain("APIエラーで中断したまま止まっています");
  });

  it("自動での再送信をしていないことに触れる", () => {
    expect(body).toContain("自動では再送信していません");
  });

  it("曖昧な継続指示を避け、事実を明言した具体的な文言を提示する（#2675）", () => {
    expect(body).toContain("「進めて」のような曖昧な継続指示は避けてください");
    expect(body).toContain("実際にはツールは呼ばれていません");
  });

  it("続きを人が引き取るための出口は共通のまま出す", () => {
    expect(body).toContain("tmux attach -t research-desk-issue-41");
    expect(body).toContain("https://claude.ai/code/session_01XYZ");
    expect(body).toContain("自動では外れません");
  });
});
