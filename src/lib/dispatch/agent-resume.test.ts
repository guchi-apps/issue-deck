import { describe, expect, it } from "vitest";

import {
  AGENT_RESUME_ACTIVITY_GRACE_MS,
  AGENT_RESUME_INSTRUCTION,
  isAgentResumeBody,
  selectStoppedSessions,
} from "@/lib/dispatch/agent-resume";
import { parseSessionInstruction } from "@/lib/dispatch/dispatch-job";

const base = {
  host: "subpc",
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 10,
  state: "ALIVE" as const,
  // 応答を終えた（`Stop`）あとにツールが走っている＝中断の時点で作業中だった形
  activity: "RESPONDED" as "WAITING_INPUT" | "WORKING" | "RESPONDED" | "NOT_STARTED" | null,
  activityAt: "2026-09-18T00:00:00.000Z" as string | null,
  stepSeenAt: "2026-09-18T00:05:00.000Z" as string | null,
};

function interrupt(overrides: Partial<Parameters<typeof selectStoppedSessions>[1][number]> = {}) {
  return {
    kind: "INTERRUPT" as const,
    status: "SUCCEEDED" as const,
    targetHost: "subpc",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 10,
    finishedAt: "2026-09-18T00:10:00.000Z",
    ...overrides,
  };
}

describe("AGENT_RESUME_INSTRUCTION", () => {
  it("追加指示として送れる形（1行・制御文字なし）で、スラッシュコマンドにならない", () => {
    expect(parseSessionInstruction(AGENT_RESUME_INSTRUCTION)).toBe(AGENT_RESUME_INSTRUCTION);
    expect(/^[/!]/.test(AGENT_RESUME_INSTRUCTION)).toBe(false);
  });

  it("固定文面だけを再開の本文として認める", () => {
    expect(isAgentResumeBody(AGENT_RESUME_INSTRUCTION)).toBe(true);
    expect(isAgentResumeBody(`${AGENT_RESUME_INSTRUCTION} `)).toBe(false);
    expect(isAgentResumeBody("何か別の指示")).toBe(false);
  });
});

describe("selectStoppedSessions", () => {
  it("C-cが成功したあと動きが無いセッションを選ぶ", () => {
    expect(selectStoppedSessions([base], [interrupt()])).toEqual([base]);
  });

  it("中断の記録が無いセッションは選ばない（手で止めていない・一時停止だけのもの）", () => {
    expect(selectStoppedSessions([base], [])).toEqual([]);
  });

  it("失敗したC-cや、別のIssue・別のホストの記録は数えない", () => {
    const jobs = [
      interrupt({ status: "FAILED" }),
      interrupt({ issueNumber: 11 }),
      interrupt({ targetHost: "other" }),
      interrupt({ finishedAt: null }),
    ];
    expect(selectStoppedSessions([base], jobs)).toEqual([]);
  });

  it("ALIVEでないセッションは選ばない", () => {
    expect(selectStoppedSessions([{ ...base, state: "GONE" as never }], [interrupt()])).toEqual([]);
  });

  it("中断のあとで動き出している（人が続けた）セッションは選ばない", () => {
    const moved = { ...base, activityAt: "2026-09-18T00:30:00.000Z" };
    expect(selectStoppedSessions([moved], [interrupt()])).toEqual([]);
  });

  it("中断直後のフックによる猶予の範囲なら、まだ止まっているものとして選ぶ", () => {
    const finishedAt = new Date("2026-09-18T00:10:00.000Z").getTime();
    const justAfter = new Date(finishedAt + AGENT_RESUME_ACTIVITY_GRACE_MS - 1000).toISOString();
    expect(selectStoppedSessions([{ ...base, stepSeenAt: justAfter }], [interrupt()])).toHaveLength(1);
  });

  it("複数回止めたときは最後のC-cを基準にする", () => {
    // 1回目のC-cのあとで動き出し、2回目のC-cで再び止まった形（最後のC-cより後に動きは無い）
    const moved = {
      ...base,
      activityAt: "2026-09-18T00:30:00.000Z",
      stepSeenAt: "2026-09-18T00:35:00.000Z",
    };
    const jobs = [interrupt(), interrupt({ finishedAt: "2026-09-18T00:40:00.000Z" })];
    expect(selectStoppedSessions([moved], jobs)).toHaveLength(1);
  });

  it("activityAtが無いセッションは、記録があれば選ぶ", () => {
    expect(selectStoppedSessions([{ ...base, activityAt: null }], [interrupt()])).toHaveLength(1);
  });

  it("ツールの実行（stepSeenAt）だけが中断のあとで進んだ場合も、動き出したものとして選ばない", () => {
    const moved = { ...base, stepSeenAt: "2026-09-18T00:30:00.000Z" };
    expect(selectStoppedSessions([moved], [interrupt()])).toEqual([]);
  });

  it("人の答えを待っていた（質問・承認待ち）セッションは、再開の対象にしない", () => {
    const waiting = { ...base, activity: "WAITING_INPUT" as const };
    expect(selectStoppedSessions([waiting], [interrupt()])).toEqual([]);
  });

  it("応答を終えて待機していた（最後のツールより`Stop`が新しい）セッションは対象にしない", () => {
    const idle = { ...base, activityAt: "2026-09-18T00:08:00.000Z", stepSeenAt: "2026-09-18T00:05:00.000Z" };
    expect(selectStoppedSessions([idle], [interrupt()])).toEqual([]);
    expect(selectStoppedSessions([{ ...idle, stepSeenAt: null }], [interrupt()])).toEqual([]);
  });

  it("手掛かりが無い（フックの報告が無い）セッションは判断できないので対象に含める", () => {
    const unknown = { ...base, activity: null, activityAt: null, stepSeenAt: null };
    expect(selectStoppedSessions([unknown], [interrupt()])).toHaveLength(1);
  });
});
