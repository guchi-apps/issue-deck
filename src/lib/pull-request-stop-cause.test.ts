import { describe, expect, it } from "vitest";

import { buildSessionInterruptedCommentBody } from "@/lib/dispatch/session-escalation";
import { resolveStopCause, type StopCauseTimelineEvent } from "@/lib/pull-request-stop-cause";

const labeled = (name: string, at: string): StopCauseTimelineEvent => ({
  event: "labeled",
  created_at: at,
  label: { name },
});
const unlabeled = (name: string, at: string): StopCauseTimelineEvent => ({
  event: "unlabeled",
  created_at: at,
  label: { name },
});
const commented = (body: string, at: string, id = at): StopCauseTimelineEvent => ({
  event: "commented",
  created_at: at,
  body,
  html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
});

const interrupted = (reason: Parameters<typeof buildSessionInterruptedCommentBody>[0]["reason"]) =>
  buildSessionInterruptedCommentBody({
    hostName: "subpc",
    tmuxSessionName: "morrow-issue-641",
    detail: null,
    remoteControlUrl: null,
    reason,
  });

/** #5080の再現例（guchi-apps/morrow#641）。#5080より前の引き上げなので種別マーカーは無い */
const LEGACY_CLASSIFIER_BLOCKED = [
  "⚠️ このIssueの実装セッションが、auto modeのクラシファイアにコマンドを拒否されたまま",
  "応答を終えています。",
  "",
  "- ホスト: `subpc`",
  "",
  "<!-- supervisor:session-interrupted -->",
].join("\n");

describe("resolveStopCause", () => {
  it("付与直前の引き上げコメント（マーカーなしの旧形式）から原因と次の操作を出す", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        labeled("00.check-user", "2026-10-26T12:23:12Z"),
        labeled("01.check-plan", "2026-10-26T12:23:14Z"),
        commented("✅ 計画を承認しました", "2026-10-26T12:30:27Z"),
        unlabeled("00.check-user", "2026-10-26T12:30:28Z"),
        commented(LEGACY_CLASSIFIER_BLOCKED, "2026-10-26T12:31:59Z", "c1"),
        labeled("00.check-user", "2026-10-26T12:32:00Z"),
        labeled("01.check-blocked", "2026-10-26T12:32:01Z"),
        commented("🔧 実装が完了し、developへのPRを作成しました", "2026-10-26T12:36:54Z"),
      ],
    });
    expect(result?.labeledAt).toBe("2026-10-26T12:32:00Z");
    expect(result?.cause).toMatchObject({
      status: "identified",
      title: "コマンドが拒否されたまま応答を終えています",
      sourceUrl: "https://github.com/o/r/issues/1#issuecomment-c1",
      sourceAt: "2026-10-26T12:31:59Z",
      stallPanel: true,
    });
    if (result?.cause.status !== "identified") throw new Error("unreachable");
    expect(result.cause.actions[0]).toContain("「進めて」だけでは解けません");
  });

  it("種別マーカーがあれば文言ではなくマーカーで種別を読む", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        commented(interrupted("tool_call_stall"), "2026-10-26T12:00:00Z"),
        labeled("00.check-user", "2026-10-26T12:00:01Z"),
      ],
    });
    expect(result?.cause).toMatchObject({ status: "identified", title: "ツールを呼び出さないまま応答を終えています" });
  });

  it("前回の解除より前の引き上げは、今の原因として使わない", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        commented(interrupted("api_error"), "2026-10-26T12:00:00Z"),
        labeled("00.check-user", "2026-10-26T12:00:01Z"),
        unlabeled("00.check-user", "2026-10-26T12:02:00Z"),
        commented("自由文の相談です", "2026-10-26T12:03:00Z", "free"),
        labeled("00.check-user", "2026-10-26T12:03:01Z"),
      ],
    });
    expect(result?.cause).toEqual({
      status: "unidentified",
      why: "no-record",
      investigate: [{ label: "ラベル付与の直前のコメント", url: "https://github.com/o/r/issues/1#issuecomment-free" }],
    });
  });

  it("付与の10分以上前の記録は採らない", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        commented(interrupted("api_error"), "2026-10-26T11:00:00Z"),
        labeled("00.check-user", "2026-10-26T12:00:00Z"),
      ],
    });
    expect(result?.cause.status).toBe("unidentified");
  });

  it("違う原因の記録が複数あれば決めない", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        commented("異常終了\n<!-- supervisor:session-failed -->", "2026-10-26T12:00:00Z", "a"),
        commented(interrupted("classifier_blocked"), "2026-10-26T12:01:00Z", "b"),
        labeled("00.check-user", "2026-10-26T12:01:01Z"),
      ],
    });
    expect(result?.cause).toMatchObject({ status: "unidentified", why: "multiple" });
    if (result?.cause.status !== "unidentified") throw new Error("unreachable");
    expect(result.cause.investigate.map((link) => link.url)).toEqual([
      "https://github.com/o/r/issues/1#issuecomment-a",
      "https://github.com/o/r/issues/1#issuecomment-b",
    ]);
  });

  it("同じ原因の再投稿は1件として最新を採る", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [
        commented(interrupted("api_error"), "2026-10-26T12:00:00Z", "old"),
        labeled("00.check-user", "2026-10-26T12:00:01Z"),
        commented(interrupted("api_error"), "2026-10-26T12:05:00Z", "new"),
      ],
    });
    expect(result?.cause).toMatchObject({
      status: "identified",
      sourceUrl: "https://github.com/o/r/issues/1#issuecomment-new",
    });
  });

  it("計画の承認待ちは理由ラベルそのものを出所にする", () => {
    const result = resolveStopCause({
      checkReason: "plan",
      timeline: [labeled("00.check-user", "2026-10-26T12:00:00Z"), labeled("01.check-plan", "2026-10-26T12:00:02Z")],
    });
    expect(result?.cause).toMatchObject({
      status: "identified",
      sourceLabel: "理由ラベル`01.check-plan`",
      sourceUrl: null,
      sourceAt: "2026-10-26T12:00:02Z",
    });
  });

  it("timelineの最後が解除ならラベルは外れていると読み、出さない", () => {
    const result = resolveStopCause({
      checkReason: "blocked",
      timeline: [labeled("00.check-user", "2026-10-26T12:00:00Z"), unlabeled("00.check-user", "2026-10-26T12:10:00Z")],
    });
    expect(result).toBeNull();
  });
});
