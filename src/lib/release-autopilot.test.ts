import { describe, expect, it } from "vitest";

import { AUTOPILOT_TTL_MS, decideAutopilot, type AutopilotInput } from "@/lib/release-autopilot";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

const createdAt = new Date("2026-11-28T00:00:00Z");

function verification(aiReview: object, integration: object = { state: "passed" }): ReleaseVerificationSummary {
  return { aiReview: { findings: [], ...aiReview }, integration } as unknown as ReleaseVerificationSummary;
}

function input(overrides: Partial<AutopilotInput> = {}): AutopilotInput {
  return {
    now: new Date(createdAt.getTime() + 60_000),
    startedAt: createdAt,
    phase: "review",
    hasPendingRevision: false,
    runActive: false,
    candidateRunStatus: null,
    approvalStatus: null,
    contract: null,
    verification: null,
    labels: [],
    ...overrides,
  };
}

const ready = { requiresAiReviewWaiver: false };
const undecided = verification({ state: "needs_check", decisions: { counts: { undecidedBlocking: 2, fixNow: 0 } } });

describe("decideAutopilot", () => {
  it("合格した候補は公開承認を出す（系列が承認待ちで残っていても）", () => {
    expect(decideAutopilot(input({ contract: ready }))).toEqual({ action: "approve" });
    expect(decideAutopilot(input({ contract: ready, runActive: true, candidateRunStatus: "awaiting_approval" }))).toEqual({ action: "approve" });
  });

  it("全体レビューを承知で進む必要がある候補は承認せず、実行障害は系列へ渡す", () => {
    const decision = decideAutopilot(input({ contract: { requiresAiReviewWaiver: true }, verification: verification({ state: "failed" }) }));
    expect(decision).toEqual({ action: "start_fix" });
  });

  it("未判断の指摘は確定し、今回直す指摘が残れば自動修正を始める", () => {
    expect(decideAutopilot(input({ verification: undecided }))).toEqual({ action: "decide_findings" });
    const fixNow = verification({ state: "needs_check", decisions: { counts: { undecidedBlocking: 0, fixNow: 1 } } });
    expect(decideAutopilot(input({ verification: fixNow }))).toEqual({ action: "start_fix" });
  });

  it("統合検証が終わる前と、系列・取り込みが動いている間は待つ", () => {
    const pending = verification({ state: "needs_check", decisions: { counts: { undecidedBlocking: 1, fixNow: 0 } } }, { state: "running" });
    expect(decideAutopilot(input({ verification: pending }))).toEqual({ action: "wait" });
    expect(decideAutopilot(input({ verification: undecided, runActive: true }))).toEqual({ action: "wait" });
    expect(decideAutopilot(input({ contract: ready, hasPendingRevision: true }))).toEqual({ action: "wait" });
  });

  it("環境不足の失敗・人の確認ラベル・期限切れでは止める", () => {
    const environment = verification({ state: "passed" }, { state: "failed", summary: "P1001", reason: null });
    expect(decideAutopilot(input({ verification: environment }))).toMatchObject({ action: "stop", reason: "integration_environment" });
    expect(decideAutopilot(input({ contract: ready, labels: ["22.merge-confirm-required"] }))).toMatchObject({ action: "stop", reason: "human_check_label" });
    expect(decideAutopilot(input({ contract: ready, now: new Date(createdAt.getTime() + AUTOPILOT_TTL_MS) }))).toMatchObject({ action: "stop", reason: "expired" });
  });

  it("系列の停止・承認の取消の後は、合格していても承認し直さない", () => {
    expect(decideAutopilot(input({ contract: ready, candidateRunStatus: "stopped" }))).toMatchObject({ action: "stop", notify: false });
    expect(decideAutopilot(input({ contract: ready, approvalStatus: "revoked" }))).toMatchObject({ action: "stop", reason: "approval_ended" });
    expect(decideAutopilot(input({ contract: ready, approvalStatus: "active" }))).toEqual({ action: "wait" });
  });

  it("公開準備に入った後は系列に任せ、系列が止まったら停止にする", () => {
    expect(decideAutopilot(input({ phase: "awaiting_approval", candidateRunStatus: "needs_attention" }))).toMatchObject({ action: "stop" });
    expect(decideAutopilot(input({ phase: "preparing", contract: ready }))).toEqual({ action: "wait" });
  });
});
