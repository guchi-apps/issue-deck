import { describe, expect, it } from "vitest";

import {
  findSessionForIssue,
  isSessionWaitingInput,
  shortIssueSessionLabel,
  summarizeIssueSession,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: REPO,
    issueNumber: 1,
    issueTitle: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T00:00:00.000Z",
    lastReportedAt: "2026-08-14T00:00:00.000Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    ...overrides,
  };
}

describe("findSessionForIssue", () => {
  it("別Issue・別リポジトリは選ばない", () => {
    expect(
      findSessionForIssue(
        [session({ issueNumber: 2 }), session({ repositoryFullName: "guchi-apps/other" })],
        REPO,
        1,
      ),
    ).toBeNull();
  });

  it("生きているセッションを最優先する", () => {
    const found = findSessionForIssue(
      [
        session({ host: "old", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
        session({ host: "subpc", state: "ALIVE", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
      ],
      REPO,
      1,
    );
    expect(found?.host).toBe("subpc");
  });

  it("生きているものが無ければ直近に報告のあったもの", () => {
    const found = findSessionForIssue(
      [
        session({ host: "old", state: "EXITED", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
        session({ host: "subpc", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
      ],
      REPO,
      1,
    );
    expect(found?.host).toBe("subpc");
  });
});

describe("summarizeIssueSession", () => {
  it("ALIVEで様子の報告が無ければ実行中", () => {
    const s = summarizeIssueSession(session());
    expect(s.tone).toBe("running");
    expect(s.label).toContain("サブPCで実行中");
  });

  it("入力待ちはRemote Controlの案内を添える", () => {
    const s = summarizeIssueSession(
      session({ activity: "WAITING_INPUT", remoteControlUrl: "https://claude.ai/code/x" }),
    );
    expect(s.tone).toBe("waiting");
    expect(s.remoteControlUrl).toBe("https://claude.ai/code/x");
    expect(s.detail).toContain("Remote Control");
  });

  // #1357。承認に答えた直後をRESPONDEDで表すと「応答を終えています」と出てしまう
  it("入力に答えて作業へ戻った報告は、作業中として出す（入力待ちでも応答終了でもない）", () => {
    const s = summarizeIssueSession(session({ activity: "WORKING" }));
    expect(s.tone).toBe("running");
    expect(s.label).toContain("作業中");
    expect(s.detail).not.toContain("次の指示");
  });

  it("応答終了は「終わっている場合と次の指示待ちの場合がある」と断る", () => {
    const s = summarizeIssueSession(session({ activity: "RESPONDED" }));
    expect(s.tone).toBe("running");
    expect(s.detail).toContain("次の指示");
  });

  // 落ちたセッションに古い「入力待ち」が残らないことの担保
  it("セッションが落ちていれば、入力待ちの報告が残っていても状態を優先する", () => {
    const s = summarizeIssueSession(
      session({ state: "FAILED", exitStatus: 1, activity: "WAITING_INPUT" }),
    );
    expect(s.tone).toBe("error");
    expect(s.detail).toContain("終了コード 1");
  });

  it("落ちたセッションのRemote Controlは出さない（開いても意味が無い）", () => {
    const s = summarizeIssueSession(
      session({ state: "GONE", activity: "WAITING_INPUT", remoteControlUrl: "https://claude.ai/code/x" }),
    );
    expect(s.tone).toBe("done");
    expect(s.remoteControlUrl).toBeNull();
  });

  // #1353。pollerは1巡ごとにlastReportedAtを更新するため、これを入力待ちに添えると
  // 何時間前の入力待ちでも「たった今」に見える
  describe("見出しに添える時刻（#1353）", () => {
    it("入力待ち・応答終了はフックが報告してきた時刻を指す", () => {
      const view = session({
        activityAt: "2026-08-14T09:00:00.000Z",
        lastReportedAt: "2026-08-14T12:00:00.000Z",
      });
      expect(summarizeIssueSession({ ...view, activity: "WAITING_INPUT" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
      expect(summarizeIssueSession({ ...view, activity: "RESPONDED" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
      expect(summarizeIssueSession({ ...view, activity: "WORKING" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
    });

    it("様子の報告が無ければpollerが最後に見た時刻", () => {
      expect(summarizeIssueSession(session({ lastReportedAt: "2026-08-14T12:00:00.000Z" })).at).toBe(
        "2026-08-14T12:00:00.000Z",
      );
    });

    it("終了・異常終了もpollerが最後に見た時刻（終わった時刻に相当する）", () => {
      const view = session({
        state: "FAILED",
        activity: "WAITING_INPUT",
        activityAt: "2026-08-14T09:00:00.000Z",
        lastReportedAt: "2026-08-14T12:00:00.000Z",
      });
      expect(summarizeIssueSession(view).at).toBe("2026-08-14T12:00:00.000Z");
    });
  });

  it("終了コードが取れなければ補足を出さない", () => {
    expect(summarizeIssueSession(session({ state: "FAILED" })).detail).toBeNull();
  });
});

describe("shortIssueSessionLabel", () => {
  it("通常の実行中は出さない（一覧が情報で埋まる）", () => {
    expect(shortIssueSessionLabel(session())).toBeNull();
    expect(shortIssueSessionLabel(session({ activity: "RESPONDED" }))).toBeNull();
    expect(shortIssueSessionLabel(session({ activity: "WORKING" }))).toBeNull();
  });

  it("入力待ち・終了・異常終了だけを出す", () => {
    expect(shortIssueSessionLabel(session({ activity: "WAITING_INPUT" }))).toBe("入力待ち");
    expect(shortIssueSessionLabel(session({ state: "EXITED" }))).toBe("終了");
    expect(shortIssueSessionLabel(session({ state: "FAILED" }))).toBe("異常終了");
  });

  it("まだ開始していないセッションも出す（人が端末で答えるまで進まない。#1465）", () => {
    expect(shortIssueSessionLabel(session({ activity: "NOT_STARTED" }))).toBe("未開始");
  });
});

/**
 * #1465。フォルダの信頼確認で止まっている間はセッションが始まっておらず、Remote Controlも
 * 繋がっていない。答えられる場所（端末）を出さないと、画面から辿れる出口が無くなる。
 */
describe("まだ開始していないセッション（#1465）", () => {
  it("待ちとして出し、tmuxのセッション名を添える", () => {
    const s = summarizeIssueSession(
      session({
        activity: "NOT_STARTED",
        activityAt: "2026-08-14T00:05:00.000Z",
        tmuxSessionName: "issue-deck-issue-1465",
      }),
    );
    expect(s.tone).toBe("waiting");
    expect(s.label).toContain("まだ開始していません");
    expect(s.detail).toContain("tmux attach -t issue-deck-issue-1465");
    expect(s.at).toBe("2026-08-14T00:05:00.000Z");
  });

  it("Remote ControlのURLは出さない（まだ繋がっていない）", () => {
    const s = summarizeIssueSession(
      session({
        activity: "NOT_STARTED",
        remoteControlUrl: "https://claude.ai/code/session_abc",
      }),
    );
    expect(s.remoteControlUrl).toBeNull();
  });

  it("承認ボタンを引っ込める入力待ち（#1417）とは別に扱う", () => {
    expect(isSessionWaitingInput(session({ activity: "NOT_STARTED" }))).toBe(false);
  });
});

describe("プレビューURL（#1265）", () => {
  it("生きているセッションでは出す", () => {
    const s = summarizeIssueSession(
      session({ previewUrl: "http://subpc.tail5210f2.ts.net:4123" }),
    );
    expect(s.previewUrl).toBe("http://subpc.tail5210f2.ts.net:4123");
  });

  it.each([["EXITED"], ["GONE"], ["FAILED"]] as const)(
    "%sのセッションでは出さない（serveは撤去済みで繋がらない）",
    (state) => {
      const s = summarizeIssueSession(
        session({ state, previewUrl: "http://subpc.tail5210f2.ts.net:4123" }),
      );
      expect(s.previewUrl).toBeNull();
    },
  );
});

/**
 * #1417。承認欄のボタンを引っ込めるかどうかの判断に使う。
 * **落ちたセッションの`WAITING_INPUT`は待つ相手がいない古い値**なので、ここまで隠すと
 * 画面から`00.check-user`を外す手段が無くなる。
 */
describe("isSessionWaitingInput", () => {
  it("生きているセッションが入力待ちのときだけ真", () => {
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "WAITING_INPUT" }))).toBe(true);
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "WORKING" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "RESPONDED" }))).toBe(false);
  });

  it("落ちたセッションの入力待ちは真としない", () => {
    expect(isSessionWaitingInput(session({ state: "FAILED", activity: "WAITING_INPUT" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "EXITED", activity: "WAITING_INPUT" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "GONE", activity: "WAITING_INPUT" }))).toBe(false);
  });

  it("セッションが無ければ偽", () => {
    expect(isSessionWaitingInput(null)).toBe(false);
  });
});
