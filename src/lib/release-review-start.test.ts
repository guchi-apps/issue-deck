import { describe, expect, it } from "vitest";

import {
  REVIEW_START_INTEGRATION_GRACE_MS,
  decideReleaseReviewStart,
  readAwaitingIntegration,
} from "./release-review-start";

const now = new Date("2026-10-18T10:00:00+09:00");
const ago = (ms: number) => new Date(now.getTime() - ms);
const integration = (state: string, createdAt: Date = ago(60_000)) => ({ state, createdAt });

describe("decideReleaseReviewStart", () => {
  it("統合検証のジョブが動いている間は待つ", () => {
    for (const status of ["QUEUED", "CLAIMED", "RUNNING"]) {
      expect(
        decideReleaseReviewStart({ integration: integration("waiting"), lastVerifyJob: { status, targetHost: "subpc", claimedAt: ago(30_000) }, now }),
      ).toEqual({ action: "wait" });
    }
    expect(
      decideReleaseReviewStart({ integration: integration("running"), lastVerifyJob: { status: "RUNNING", targetHost: "subpc", claimedAt: ago(30_000) }, now }),
    ).toEqual({ action: "wait" });
  });

  it("統合検証が終わったら、合否に依らず統合検証を実行したホストを優先して開始する", () => {
    for (const state of ["passed", "failed", "needs_check"]) {
      expect(
        decideReleaseReviewStart({ integration: integration(state), lastVerifyJob: { status: "SUCCEEDED", targetHost: "subpc-2", claimedAt: ago(30_000) }, now }),
      ).toEqual({ action: "start", reason: "integration_finished", preferredHost: "subpc-2" });
    }
    expect(
      decideReleaseReviewStart({ integration: integration("failed"), lastVerifyJob: { status: "FAILED", targetHost: "subpc", claimedAt: ago(30_000) }, now }),
    ).toMatchObject({ action: "start", preferredHost: "subpc" });
  });

  it("積めなかった・設定不足で失敗を記録した統合検証（ジョブ無し）は、優先先なしで開始する", () => {
    expect(decideReleaseReviewStart({ integration: integration("failed"), lastVerifyJob: null, now })).toEqual({
      action: "start",
      reason: "integration_finished",
      preferredHost: null,
    });
  });

  it("統合検証の記録が無い（引き継いだ・未依頼）・対象外なら待たない", () => {
    expect(decideReleaseReviewStart({ integration: null, lastVerifyJob: null, now })).toEqual({
      action: "start",
      reason: "no_integration",
      preferredHost: null,
    });
    expect(decideReleaseReviewStart({ integration: integration("not_applicable"), lastVerifyJob: null, now })).toEqual({
      action: "start",
      reason: "integration_not_pending",
      preferredHost: null,
    });
  });

  it("記録が待機中でも、ジョブが報告なしで終わっていれば開始する（取得されずに終わったジョブは優先先なし）", () => {
    expect(
      decideReleaseReviewStart({ integration: integration("waiting"), lastVerifyJob: { status: "TIMEOUT", targetHost: "subpc", claimedAt: ago(30_000) }, now }),
    ).toEqual({ action: "start", reason: "integration_job_ended", preferredHost: "subpc" });
    expect(
      decideReleaseReviewStart({ integration: integration("waiting"), lastVerifyJob: { status: "CANCELED", targetHost: "subpc", claimedAt: null }, now }),
    ).toEqual({ action: "start", reason: "integration_job_ended", preferredHost: null });
  });

  it("QUEUEDのまま期限切れになったTIMEOUT（一度も取得されていない）のホストは優先しない（#4775）", () => {
    expect(
      decideReleaseReviewStart({ integration: integration("waiting"), lastVerifyJob: { status: "TIMEOUT", targetHost: "subpc", claimedAt: null }, now }),
    ).toEqual({ action: "start", reason: "integration_job_ended", preferredHost: null });
    expect(
      decideReleaseReviewStart({ integration: integration("failed"), lastVerifyJob: { status: "TIMEOUT", targetHost: "subpc", claimedAt: null }, now }),
    ).toEqual({ action: "start", reason: "integration_finished", preferredHost: null });
  });

  it("記録が待機中でジョブがまだ無いときは、猶予の間だけ待ち、過ぎたら開始する", () => {
    expect(
      decideReleaseReviewStart({ integration: integration("waiting", ago(REVIEW_START_INTEGRATION_GRACE_MS - 1000)), lastVerifyJob: null, now }),
    ).toEqual({ action: "wait" });
    expect(
      decideReleaseReviewStart({ integration: integration("waiting", ago(REVIEW_START_INTEGRATION_GRACE_MS)), lastVerifyJob: null, now }),
    ).toEqual({ action: "start", reason: "integration_not_queued", preferredHost: null });
  });
});

describe("readAwaitingIntegration", () => {
  it("印の形が正しいときだけ読む", () => {
    expect(readAwaitingIntegration({ awaitingIntegration: { since: "2026-10-18T01:00:00.000Z" } })).toEqual({
      since: "2026-10-18T01:00:00.000Z",
    });
    expect(readAwaitingIntegration({ awaitingIntegration: {} })).toBeNull();
    expect(readAwaitingIntegration(null)).toBeNull();
    expect(readAwaitingIntegration([])).toBeNull();
  });
});
