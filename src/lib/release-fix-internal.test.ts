import { describe, expect, it } from "vitest";

import {
  decideInternalHold,
  decideInternalStop,
  evaluateInternalGate,
  INTERNAL_MAX_MINUTES,
  INTERNAL_MAX_ROUNDS,
  isInternalHoldReason,
  nextFindingKey,
  validateReviewReport,
  type InternalFindingRecord,
  type InternalRoundRecord,
} from "@/lib/release-fix-internal";

const round = (over: Partial<InternalRoundRecord> = {}): InternalRoundRecord => ({
  round: 1,
  reviewVerdict: "pass",
  reviewTargetSha: "aaa",
  testState: "passed",
  testTargetSha: "aaa",
  openFindingCount: 0,
  ...over,
});
const finding = (over: Partial<InternalFindingRecord> = {}): InternalFindingRecord => ({
  key: "F-001",
  title: "t",
  status: "resolved",
  reopenCount: 0,
  ...over,
});

describe("evaluateInternalGate", () => {
  it("同じ対象で独立レビュー合格・未解決0・テスト合格なら完了", () => {
    const gate = evaluateInternalGate({ rounds: [round()], findings: [finding()], currentSha: "aaa" });
    expect(gate.complete).toBe(true);
    expect(gate.targetSha).toBe("aaa");
  });
  it("独立レビュー未実施は完了にできない", () => {
    expect(evaluateInternalGate({ rounds: [], findings: [], currentSha: "aaa" }).blocker).toBe("no_review");
    expect(evaluateInternalGate({ rounds: [round({ reviewVerdict: null, reviewTargetSha: null })], findings: [], currentSha: "aaa" }).blocker).toBe("no_review");
  });
  it("未解決の指摘があれば完了にできない（verdictがpassでも指摘が残れば止める）", () => {
    expect(evaluateInternalGate({ rounds: [round({ reviewVerdict: "findings" })], findings: [finding({ status: "open" })], currentSha: "aaa" }).blocker).toBe("open_findings");
    expect(evaluateInternalGate({ rounds: [round()], findings: [finding({ status: "open" })], currentSha: "aaa" }).blocker).toBe("open_findings");
  });
  it("テスト未実施・失敗は完了にできない", () => {
    expect(evaluateInternalGate({ rounds: [round({ testState: null, testTargetSha: null })], findings: [], currentSha: "aaa" }).blocker).toBe("tests_not_run");
    expect(evaluateInternalGate({ rounds: [round({ testState: "failed" })], findings: [], currentSha: "aaa" }).blocker).toBe("tests_failed");
  });
  it("対象が変わったあとの古い合格は流用しない", () => {
    expect(evaluateInternalGate({ rounds: [round()], findings: [], currentSha: "bbb" }).blocker).toBe("review_target_changed");
    expect(evaluateInternalGate({ rounds: [round({ testTargetSha: "old" })], findings: [], currentSha: "aaa" }).blocker).toBe("tests_target_changed");
    expect(evaluateInternalGate({ rounds: [round()], findings: [], currentSha: null }).blocker).toBe("review_target_changed");
  });
  it("最新の往復だけを見る（前の往復の合格を持ち越さない）", () => {
    const gate = evaluateInternalGate({
      rounds: [round({ round: 1 }), round({ round: 2, reviewVerdict: "findings", reviewTargetSha: "bbb", testState: null, testTargetSha: null })],
      findings: [finding({ status: "open" })],
      currentSha: "bbb",
    });
    expect(gate.complete).toBe(false);
  });
  it("停止中は完了にできない", () => {
    expect(evaluateInternalGate({ rounds: [round()], findings: [], currentSha: "aaa", stopped: true }).blocker).toBe("stopped");
  });
});

describe("decideInternalStop", () => {
  const startedAt = new Date("2026-10-12T00:00:00Z");
  const soon = new Date("2026-10-12T00:10:00Z");
  it("通常の指摘だけでは止めない", () => {
    const rounds = [round({ round: 1, reviewVerdict: "findings", openFindingCount: 2 }), round({ round: 2, reviewVerdict: "findings", openFindingCount: 1 })];
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open" })], startedAt, now: soon })).toEqual({ stop: false });
  });
  it("往復の上限に達したら止める", () => {
    const rounds = Array.from({ length: INTERNAL_MAX_ROUNDS }, (_, i) => round({ round: i + 1, reviewVerdict: "findings", openFindingCount: 5 - i }));
    expect(decideInternalStop({ rounds, findings: [], startedAt, now: soon })).toMatchObject({ stop: true, reason: "max_rounds" });
  });
  it("最新が合格なら上限に達していても止めない", () => {
    const rounds = Array.from({ length: INTERNAL_MAX_ROUNDS }, (_, i) => round({ round: i + 1, reviewVerdict: i === INTERNAL_MAX_ROUNDS - 1 ? "pass" : "findings", openFindingCount: 1 }));
    expect(decideInternalStop({ rounds, findings: [], startedAt, now: soon }).stop).toBe(false);
  });
  it("経過時間の上限で止める", () => {
    const later = new Date(startedAt.getTime() + INTERNAL_MAX_MINUTES * 60_000);
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "findings", openFindingCount: 1 })], findings: [], startedAt, now: later })).toMatchObject({ reason: "timed_out" });
  });
  it("同一指摘の再発で止める", () => {
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "findings", openFindingCount: 1 })], findings: [finding({ status: "open", reopenCount: 2 })], startedAt, now: soon })).toMatchObject({
      reason: "recurring_finding",
      detail: "F-001",
    });
  });
  it("未解決の件数が減らない往復が続けば進捗なしで止める", () => {
    const rounds = [1, 2, 3].map((n) => round({ round: n, reviewVerdict: "findings", openFindingCount: 2 }));
    expect(decideInternalStop({ rounds, findings: [], startedAt, now: soon })).toMatchObject({ reason: "no_progress" });
  });
});

describe("nextFindingKey", () => {
  it("連番で採番する", () => {
    expect(nextFindingKey([])).toBe("F-001");
    expect(nextFindingKey(["F-001", "F-007"])).toBe("F-008");
  });
});

describe("validateReviewReport", () => {
  const open = [finding({ key: "F-001", status: "open" })];
  it("passなのに未解決が残る報告を弾く", () => {
    expect(validateReviewReport({ verdict: "pass", newFindings: [], stillOpen: [], resolved: [] }, open)).toContain("未解決");
  });
  it("解消を根拠付きで報告すればpassにできる", () => {
    expect(validateReviewReport({ verdict: "pass", newFindings: [], stillOpen: [], resolved: [{ key: "F-001", resolution: "route.ts:42で確認" }] }, open)).toBeNull();
  });
  it("findingsなのに指摘が無い報告・未知のIDを弾く", () => {
    expect(validateReviewReport({ verdict: "findings", newFindings: [], stillOpen: [], resolved: [{ key: "F-001", resolution: "x" }] }, open)).toContain("未解決の指摘がありません");
    expect(validateReviewReport({ verdict: "findings", newFindings: [{ title: "a" }], stillOpen: ["F-009"], resolved: [] }, open)).toContain("未知");
  });
  it("根拠が空の解消を弾く", () => {
    expect(validateReviewReport({ verdict: "pass", newFindings: [], stillOpen: [], resolved: [{ key: "F-001", resolution: " " }] }, open)).toContain("根拠");
  });
});

describe("decideInternalHold", () => {
  const incomplete = evaluateInternalGate({ rounds: [], findings: [], currentSha: "aaa" });
  const complete = evaluateInternalGate({ rounds: [round()], findings: [], currentSha: "aaa" });
  it("内部確認を求めない系列（旧い系列）は保留しない", () => {
    expect(decideInternalHold({ required: false, gate: incomplete })).toEqual({ hold: false });
  });
  it("未完了なら理由付きで保留する", () => {
    const hold = decideInternalHold({ required: true, gate: incomplete });
    expect(hold.hold).toBe(true);
    if (hold.hold) expect(isInternalHoldReason(hold.reason)).toBe(true);
  });
  it("完了していれば保留しない", () => {
    expect(decideInternalHold({ required: true, gate: complete })).toEqual({ hold: false });
  });
});
