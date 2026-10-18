import { describe, expect, it } from "vitest";

import {
  evaluateReleaseMergeGate,
  evaluateReleaseVerificationWait,
  isOnlyAiReviewBlocking,
  isReleasePullRequest,
  viewReleaseVerifications,
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

describe("evaluateReleaseVerificationWait", () => {
  const wait = (records: ReleaseVerificationRecord[]) => evaluateReleaseVerificationWait({ current, records });

  it("実行中・待機中は待ちとして返す", () => {
    const pending = wait([rec({ state: "running" }), rec({ kind: "ai_review", state: "waiting" })]);
    expect(pending.map((p) => p.kind)).toEqual(["integration", "ai_review"]);
  });

  it("片方だけ実行中でも待つ", () => {
    expect(wait([rec({}), rec({ kind: "ai_review", state: "running" })]).map((p) => p.kind)).toEqual(["ai_review"]);
  });

  it("判定が出ていれば結果が何でも待たない", () => {
    expect(wait([rec({ state: "failed" }), rec({ kind: "ai_review", unverifiedScope: "ios" })])).toEqual([]);
  });

  it("記録が無い・古い結果は待たない", () => {
    expect(wait([])).toEqual([]);
    expect(wait([rec({ headSha: "old", state: "running" })])).toEqual([]);
  });
});

describe("全体レビューを公開の必須条件から外す（#4807）", () => {
  it("止めているのが全体レビューだけのときだけ外せる", () => {
    for (const state of ["failed", "needs_check", "running", "waiting"] as const) {
      expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, [rec({}), rec({ kind: "ai_review", state })]))).toBe(true);
    }
    // 未実施・古い結果も外せる
    expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, [rec({})]))).toBe(true);
    expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, [rec({}), rec({ kind: "ai_review", headSha: "old" })]))).toBe(true);
    // 合格済み・統合検証が未合格なら外さない
    expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, both))).toBe(false);
    expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, [rec({ state: "failed" }), rec({ kind: "ai_review", state: "failed" })]))).toBe(false);
    expect(isOnlyAiReviewBlocking(viewReleaseVerifications(current, [rec({ state: "running" }), rec({ kind: "ai_review", state: "failed" })]))).toBe(false);
  });

  it("外した対象では全体レビューの結果で止めず、統合検証と前提は従来どおり止める", () => {
    const failedReview = [rec({}), rec({ kind: "ai_review", state: "failed" })];
    expect(evaluateReleaseMergeGate({ current, records: failedReview, enforced: true }).status).toBe("blocked");
    const waived = evaluateReleaseMergeGate({ current, records: failedReview, enforced: true, aiReviewWaived: true });
    expect(waived.status).toBe("ready");
    // 表示は変えない
    expect(waived.views.find((v) => v.kind === "ai_review")?.state).toBe("failed");
    const integrationFailed = [rec({ state: "failed" }), rec({ kind: "ai_review", state: "failed" })];
    expect(evaluateReleaseMergeGate({ current, records: integrationFailed, enforced: true, aiReviewWaived: true }).status).toBe("blocked");
  });
});
