import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { AGENT_RESUME_INSTRUCTION } from "@/lib/dispatch/agent-resume";
import { resumeAgentSessions } from "@/lib/dispatch/agent-resume-run";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function session(overrides: Partial<DispatchSessionView>): DispatchSessionView {
  return {
    host: "subpc",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    state: "ALIVE",
    activity: "RESPONDED",
    activityAt: "2026-09-18T00:00:00.000Z",
    stepSeenAt: "2026-09-18T00:05:00.000Z",
    codexThreadKnown: null,
    ...overrides,
  } as DispatchSessionView;
}

function interruptFor(issueNumber: number, repositoryFullName = "guchi-apps/issue-deck") {
  return {
    kind: "INTERRUPT" as const,
    status: "SUCCEEDED" as const,
    targetHost: "subpc",
    repositoryFullName,
    issueNumber,
    finishedAt: "2026-09-18T00:10:00.000Z",
  };
}

describe("resumeAgentSessions", () => {
  it("ブロックを解除し、止まっている同エージェントのセッションだけへ固定文面を積む", async () => {
    const setPaused = vi.fn().mockResolvedValue({ claude: null, codex: null });
    const enqueue = vi.fn().mockResolvedValue({ ok: true });
    const result = await resumeAgentSessions(
      { agent: "claude", userId: "u1" },
      {
        setPaused,
        listSessions: async () => [
          session({ issueNumber: 1 }),
          session({ issueNumber: 2, codexThreadKnown: true }), // Codex（対象外）
          session({ issueNumber: 3 }), // 記録が無い
        ],
        listInterruptJobs: async () => [interruptFor(1), interruptFor(2)],
        enqueue,
      },
    );

    expect(setPaused).toHaveBeenCalledWith({ agent: "claude", paused: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 1, hostName: "subpc" }));
    expect(result).toMatchObject({ resumed: 1, failed: [] });
  });

  it("積めなかったセッションは理由つきで返し、ほかは続ける", async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, rejection: "host_offline", message: "オフラインです" })
      .mockResolvedValueOnce({ ok: true });
    const result = await resumeAgentSessions(
      { agent: "claude", userId: null },
      {
        setPaused: vi.fn().mockResolvedValue({ claude: null, codex: null }),
        listSessions: async () => [session({ issueNumber: 1 }), session({ issueNumber: 2 })],
        listInterruptJobs: async () => [interruptFor(1), interruptFor(2)],
        enqueue,
      },
    );

    expect(result.resumed).toBe(1);
    expect(result.failed).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 1, message: "オフラインです" },
    ]);
  });

  it("送る本文は固定文面の定数だけ", () => {
    expect(AGENT_RESUME_INSTRUCTION.length).toBeLessThanOrEqual(500);
  });
});
