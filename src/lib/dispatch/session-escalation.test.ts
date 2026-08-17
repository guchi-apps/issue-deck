import { describe, expect, it } from "vitest";

import { buildSessionNotStartedCommentBody } from "@/lib/dispatch/session-escalation";

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
