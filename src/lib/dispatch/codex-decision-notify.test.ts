import { beforeEach, describe, expect, it, vi } from "vitest";

const findDispatchSessionForIssue = vi.fn();
const enqueueSessionControlJob = vi.fn();

vi.mock("@/lib/dispatch/sessions", () => ({
  get findDispatchSessionForIssue() {
    return findDispatchSessionForIssue;
  },
}));

vi.mock("@/lib/dispatch/jobs", () => ({
  get enqueueSessionControlJob() {
    return enqueueSessionControlJob;
  },
}));

import {
  CODEX_PLAN_APPROVED_INSTRUCTION,
  CODEX_PLAN_REVISION_INSTRUCTION,
  CODEX_QUESTION_ANSWERED_INSTRUCTION,
  notifyCodexSessionDecision,
} from "@/lib/dispatch/codex-decision-notify";
import { parseSessionInstruction } from "@/lib/dispatch/dispatch-job";

function session(overrides: Record<string, unknown> = {}) {
  return {
    host: "subpc",
    state: "ALIVE",
    // 非nullならCodex（`resolveIssueImplementationAgent`）
    codexThreadKnown: true,
    ...overrides,
  };
}

const target = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3218 };

beforeEach(() => {
  vi.clearAllMocks();
  enqueueSessionControlJob.mockResolvedValue({ ok: true, job: { id: "job-1" } });
});

describe("notifyCodexSessionDecision", () => {
  it("Codexの生きているセッションへ、固定文面のINSTRUCTIONを積む", async () => {
    findDispatchSessionForIssue.mockResolvedValue(session());

    const result = await notifyCodexSessionDecision({
      ...target,
      kind: "plan-approved",
      requestedByUserId: "user-1",
    });

    expect(result).toEqual({ ok: true, jobId: "job-1" });
    expect(enqueueSessionControlJob).toHaveBeenCalledWith({
      ...target,
      hostName: "subpc",
      kind: "INSTRUCTION",
      instruction: CODEX_PLAN_APPROVED_INSTRUCTION,
      requestedByUserId: "user-1",
    });
  });

  it("判断の種類ごとに送る本文が変わる", async () => {
    findDispatchSessionForIssue.mockResolvedValue(session());

    for (const [kind, body] of [
      ["plan-approved", CODEX_PLAN_APPROVED_INSTRUCTION],
      ["plan-revision", CODEX_PLAN_REVISION_INSTRUCTION],
      ["question-answered", CODEX_QUESTION_ANSWERED_INSTRUCTION],
    ] as const) {
      await notifyCodexSessionDecision({ ...target, kind, requestedByUserId: null });
      expect(enqueueSessionControlJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ instruction: body }),
      );
    }
  });

  // **Claude Codeのセッションへ積まない。** pollerは`send-keys`の3段階プロトコルの方へ倒すため、
  // 積むと人の操作を挟まない自動の`send-keys`になる（`docs/multi-agent/gates.md`）。
  // あちらはフックが`GET …/decision`で判断を取りに来るので、そもそも要らない
  it("Claude Codeのセッションには積まない", async () => {
    findDispatchSessionForIssue.mockResolvedValue(session({ codexThreadKnown: null }));

    const result = await notifyCodexSessionDecision({
      ...target,
      kind: "plan-approved",
      requestedByUserId: null,
    });

    expect(result).toEqual({ ok: false, reason: "not_codex", message: expect.any(String) });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("セッションの記録が無ければ積まない", async () => {
    findDispatchSessionForIssue.mockResolvedValue(null);

    const result = await notifyCodexSessionDecision({
      ...target,
      kind: "plan-approved",
      requestedByUserId: null,
    });

    expect(result).toMatchObject({ ok: false, reason: "no_session" });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("終わったCodexのセッションには積まず、理由を返す", async () => {
    findDispatchSessionForIssue.mockResolvedValue(session({ state: "EXITED" }));

    const result = await notifyCodexSessionDecision({
      ...target,
      kind: "question-answered",
      requestedByUserId: null,
    });

    expect(result).toMatchObject({ ok: false, reason: "not_alive" });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("ジョブを積めなかった理由はそのまま返す（判断自体は失敗させない）", async () => {
    findDispatchSessionForIssue.mockResolvedValue(session());
    enqueueSessionControlJob.mockResolvedValue({
      ok: false,
      rejection: "already_queued",
      message: "同じ操作が既に積まれています。",
    });

    const result = await notifyCodexSessionDecision({
      ...target,
      kind: "plan-revision",
      requestedByUserId: null,
    });

    expect(result).toEqual({
      ok: false,
      reason: "already_queued",
      message: "同じ操作が既に積まれています。",
    });
  });

  // 受け口・poller側の検証（改行なし・500字まで）を、固定文面そのものが通ることで確かめる
  it("どの固定文面も追加指示の検証を通る", () => {
    for (const body of [
      CODEX_PLAN_APPROVED_INSTRUCTION,
      CODEX_PLAN_REVISION_INSTRUCTION,
      CODEX_QUESTION_ANSWERED_INSTRUCTION,
    ]) {
      expect(parseSessionInstruction(body)).toBe(body);
    }
  });
});
