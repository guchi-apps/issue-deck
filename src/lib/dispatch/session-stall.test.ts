import { describe, expect, it } from "vitest";

import { describeSessionStall, isSessionStallRecoveryBody } from "@/lib/dispatch/session-stall";
import { parseSessionInstruction } from "@/lib/dispatch/dispatch-job";
import {
  SESSION_INTERRUPTED_REASONS,
  type DispatchSessionView,
} from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";
const INTERRUPTED_AT = "2026-09-07T10:00:00.000Z";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: REPO,
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-09-07T09:00:00.000Z",
    lastReportedAt: "2026-09-07T10:05:00.000Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    answerInApp: false,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    interruptedReason: "api_error",
    interruptedAt: INTERRUPTED_AT,
    models: [],
    ...overrides,
  };
}

describe("describeSessionStall", () => {
  it("引き上げが残っている生きたセッションでは、原因ごとの文面を返す", () => {
    const notice = describeSessionStall(session());
    expect(notice?.reason).toBe("api_error");
    expect(notice?.presets.length).toBeGreaterThan(0);
  });

  it("引き上げが無ければ何も出さない", () => {
    expect(
      describeSessionStall(session({ interruptedReason: null, interruptedAt: null })),
    ).toBeNull();
  });

  // 終わったセッションの出口は「セッションを復旧」（起動ジョブを積み直す別の操作）
  it("終わったセッションには出さない", () => {
    expect(describeSessionStall(session({ state: "EXITED" }))).toBeNull();
    expect(describeSessionStall(session({ state: "GONE" }))).toBeNull();
  });

  // 解除の受け口を作らず、フックの報告が引き上げ時刻を追い越したかで判定している
  it("引き上げの後にフックの報告があれば、動き出したとみなして出さない", () => {
    expect(
      describeSessionStall(session({ activityAt: "2026-09-07T10:01:00.000Z" })),
    ).toBeNull();
    expect(
      describeSessionStall(session({ stepSeenAt: "2026-09-07T10:01:00.000Z" })),
    ).toBeNull();
  });

  // `tool_call_stall`・`classifier_blocked`は引き上げの直前に`Stop`が発火する形なので、
  // 同時刻を「動き出した」と読むとパネルが一度も出ない
  it("引き上げと同時刻・それ以前の報告は、まだ停滞しているとみなす", () => {
    expect(describeSessionStall(session({ activityAt: INTERRUPTED_AT }))).not.toBeNull();
    expect(
      describeSessionStall(session({ activityAt: "2026-09-07T09:59:00.000Z" })),
    ).not.toBeNull();
  });

  it("時刻が壊れていれば出さない（原因だけでは鮮度が分からない）", () => {
    expect(describeSessionStall(session({ interruptedAt: "not-a-date" }))).toBeNull();
  });
});

describe("固定文面", () => {
  it("すべての原因に、追加指示として送れる形の文面が用意されている", () => {
    for (const reason of SESSION_INTERRUPTED_REASONS) {
      const notice = describeSessionStall(session({ interruptedReason: reason }));
      expect(notice).not.toBeNull();
      expect(notice?.presets.length).toBeGreaterThan(0);
      for (const preset of notice?.presets ?? []) {
        // 改行・制御文字・長さの制約は追加指示（#1012）と同じ関数で見る。ここを通らない
        // 文面を置くと、押せたのに受け口が400で弾く
        expect(parseSessionInstruction(preset.body)).toBe(preset.body);
      }
    }
  });

  it("その原因に用意された文面だけを受け入れる", () => {
    const preset = describeSessionStall(session())?.presets[0];
    expect(preset).toBeDefined();
    expect(isSessionStallRecoveryBody("api_error", preset!.body)).toBe(true);
    // 別の原因の文面は通さない（原因ごとに送るものが違う）
    expect(isSessionStallRecoveryBody("tool_call_stall", preset!.body)).toBe(false);
    // 任意の本文は「追加指示を送る」の担当
    expect(isSessionStallRecoveryBody("api_error", "進めて")).toBe(false);
  });
});
