import { describe, expect, it } from "vitest";

import {
  accrueActiveSeconds,
  appendAttempt,
  classifyLegacyStopReason,
  decideInternalHold,
  decideInternalResume,
  decideInternalStop,
  evaluateInternalGate,
  INTERNAL_ACTIVE_GAP_MINUTES,
  INTERNAL_MAX_ATTEMPTS,
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

describe("decideInternalStop（#4587）", () => {
  const base = { activeMinutes: 10, budgetMinutes: 120 };
  it("通常の指摘だけでは止めない", () => {
    const rounds = [round({ round: 1, reviewVerdict: "findings", openFindingCount: 2 }), round({ round: 2, reviewVerdict: "findings", openFindingCount: 1 })];
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open" })], ...base })).toEqual({ stop: false });
  });
  it("5往復を超えても、件数が減っていれば回数だけでは止めない", () => {
    const rounds = Array.from({ length: 8 }, (_, i) => round({ round: i + 1, reviewVerdict: "findings", openFindingCount: 8 - i }));
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open" })], ...base })).toEqual({ stop: false });
  });
  it("稼働時間が予算に達したら一時停止する。待機の長さは関係しない", () => {
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "findings", openFindingCount: 1 })], findings: [], activeMinutes: 120, budgetMinutes: 120 })).toMatchObject({ reason: "budget_reached" });
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "findings", openFindingCount: 1 })], findings: [], activeMinutes: 119, budgetMinutes: 120 }).stop).toBe(false);
  });
  it("最新がpassでもゲート完了前に予算を超えたら止める。完了していれば止めない", () => {
    const over = { activeMinutes: 130, budgetMinutes: 120 };
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "pass" })], findings: [], ...over })).toMatchObject({ reason: "budget_reached" });
    expect(decideInternalStop({ rounds: [round({ reviewVerdict: "pass" })], findings: [], ...over, gateComplete: true }).stop).toBe(false);
  });
  it("同一指摘が変更も解消も無いまま再指摘されたら停滞として止める", () => {
    const rounds = [1, 2].map((n) => round({ round: n, reviewVerdict: "findings", reviewTargetSha: "same", openFindingCount: 1 }));
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open", reopenCount: 2 })], ...base })).toMatchObject({ reason: "recurring_finding", detail: "F-001" });
  });
  it("再指摘が続いても、対象が変わり件数が減っていれば停滞と断定しない", () => {
    const rounds = [
      round({ round: 1, reviewVerdict: "findings", reviewTargetSha: "a1", openFindingCount: 3 }),
      round({ round: 2, reviewVerdict: "findings", reviewTargetSha: "a2", openFindingCount: 2 }),
    ];
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open", reopenCount: 2 })], ...base }).stop).toBe(false);
  });
  it("未解決の件数が減らず解消の根拠も無い往復が続けば進捗なしで止める", () => {
    const rounds = [1, 2, 3].map((n) => round({ round: n, reviewVerdict: "findings", openFindingCount: 2 }));
    expect(decideInternalStop({ rounds, findings: [finding({ status: "open" })], ...base })).toMatchObject({ reason: "no_progress" });
  });
  it("件数が減らなくても、その間に別の指摘を解消していれば進捗とみなす", () => {
    const rounds = [1, 2, 3].map((n) => round({ round: n, reviewVerdict: "findings", openFindingCount: 2 }));
    const findings = [finding({ key: "F-001", status: "resolved", lastRound: 2 }), finding({ key: "F-002", status: "open" })];
    expect(decideInternalStop({ rounds, findings, ...base }).stop).toBe(false);
  });
});

describe("稼働時間・再開・履歴（#4587）", () => {
  const t0 = new Date("2026-10-13T00:00:00Z");
  it("前回の活動からの間隔は上限までしか算入しない（長い待機・中断は消費しない）", () => {
    const soon = new Date(t0.getTime() + 3 * 60_000);
    expect(accrueActiveSeconds({ activeSeconds: 60, lastActivityAt: t0, now: soon })).toBe(60 + 180);
    const afterWait = new Date(t0.getTime() + 5 * 3600_000);
    expect(accrueActiveSeconds({ activeSeconds: 60, lastActivityAt: t0, now: afterWait })).toBe(60 + INTERNAL_ACTIVE_GAP_MINUTES * 60);
    expect(accrueActiveSeconds({ activeSeconds: 60, lastActivityAt: null, now: afterWait })).toBe(60);
  });
  it("予算到達は予算の追加、停滞は方針、実行障害は入力なしで再開できる", () => {
    expect(decideInternalResume({ kind: "budget_reached", addMinutes: null, direction: null })).toMatchObject({ ok: false, error: "input_required" });
    expect(decideInternalResume({ kind: "budget_reached", addMinutes: 60, direction: null })).toEqual({ ok: true, addMinutes: 60 });
    expect(decideInternalResume({ kind: "no_progress", addMinutes: null, direction: " " })).toMatchObject({ ok: false });
    expect(decideInternalResume({ kind: "recurring_finding", addMinutes: null, direction: "F-001は別方式で直す" })).toMatchObject({ ok: true });
    expect(decideInternalResume({ kind: "environment", addMinutes: null, direction: null })).toEqual({ ok: true, addMinutes: 0 });
  });
  it("試行履歴には上限がある", () => {
    let history: unknown = null;
    for (let i = 0; i < INTERNAL_MAX_ATTEMPTS + 5; i += 1) history = appendAttempt(history, { at: String(i), kind: "claim", by: "a", detail: null, sha: null });
    expect((history as unknown[]).length).toBe(INTERNAL_MAX_ATTEMPTS);
  });
  it("旧方式の停止理由を新方式の原因へ読み替える", () => {
    expect(classifyLegacyStopReason("同じ指摘（F-001）が解消されないまま")).toBe("recurring_finding");
    expect(classifyLegacyStopReason("未解決の指摘が2往復続けて減っていません")).toBe("no_progress");
    expect(classifyLegacyStopReason("独立レビューの往復が上限（5回）に達しました")).toBe("budget_reached");
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
