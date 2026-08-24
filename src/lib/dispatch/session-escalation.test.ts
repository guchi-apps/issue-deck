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
});
