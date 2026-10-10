import { describe, expect, it } from "vitest";

import {
  evaluateReleaseMergeGate,
  isReleasePullRequest,
  type ReleaseVerificationRecord,
} from "./release-merge-gate";

const current = { baseSha: "b1", headSha: "h1" };
const rec = (over: Partial<ReleaseVerificationRecord>): ReleaseVerificationRecord => ({
  kind: "integration",
  state: "passed",
  baseSha: "b1",
  headSha: "h1",
  ...over,
});
const both = [rec({}), rec({ kind: "ai_review" })];

describe("evaluateReleaseMergeGate", () => {
  it("強制しないリポジトリでは判定しない", () => {
    expect(evaluateReleaseMergeGate({ current, records: [], enforced: false }).status).toBe("not_enforced");
  });

  it("両方成功なら通常マージへ進める", () => {
    expect(evaluateReleaseMergeGate({ current, records: both, enforced: true }).status).toBe("ready");
  });

  it("対象外は成功と同じく通す", () => {
    const records = [rec({ state: "not_applicable" }), rec({ kind: "ai_review" })];
    expect(evaluateReleaseMergeGate({ current, records, enforced: true }).status).toBe("ready");
  });

  it("記録が無ければ未実施として止める", () => {
    const gate = evaluateReleaseMergeGate({ current, records: [], enforced: true });
    expect(gate.status).toBe("blocked");
    expect(gate.blockers.map((b) => b.state)).toEqual(["not_run", "not_run"]);
  });

  it("SHAが食い違う古い成功は流用せず無効にする", () => {
    const records = [rec({ headSha: "old" }), rec({ kind: "ai_review", baseSha: "old" })];
    const gate = evaluateReleaseMergeGate({ current, records, enforced: true });
    expect(gate.status).toBe("blocked");
    expect(gate.views.map((v) => v.state)).toEqual(["invalidated", "invalidated"]);
  });

  it("失敗・実行中・待機は止める", () => {
    for (const state of ["failed", "running", "waiting"] as const) {
      const gate = evaluateReleaseMergeGate({
        current,
        records: [rec({ state }), rec({ kind: "ai_review" })],
        enforced: true,
      });
      expect(gate.status).toBe("blocked");
    }
  });

  it("未確認範囲が残るLGTMは通常の準備完了にしない", () => {
    const records = [rec({}), rec({ kind: "ai_review", unverifiedScope: "src/lib/big.ts" })];
    const gate = evaluateReleaseMergeGate({ current, records, enforced: true });
    expect(gate.status).toBe("needs_confirmation");
    expect(gate.blockers[0].reason).toContain("src/lib/big.ts");
  });

  it("要確認は確認フローへ、失敗と同居すれば止める", () => {
    const needs = [rec({}), rec({ kind: "ai_review", state: "needs_check" })];
    expect(evaluateReleaseMergeGate({ current, records: needs, enforced: true }).status).toBe(
      "needs_confirmation",
    );
    const mixed = [rec({ state: "failed" }), rec({ kind: "ai_review", state: "needs_check" })];
    expect(evaluateReleaseMergeGate({ current, records: mixed, enforced: true }).status).toBe("blocked");
  });
});

describe("isReleasePullRequest", () => {
  it("base=mainかつhead=release-main/v*だけ", () => {
    expect(isReleasePullRequest({ baseRef: "main", headRef: "release-main/v1.2.3" })).toBe(true);
    expect(isReleasePullRequest({ baseRef: "develop", headRef: "release-main/v1.2.3" })).toBe(false);
    expect(isReleasePullRequest({ baseRef: "main", headRef: "deploy-recovery/x" })).toBe(false);
  });
});
