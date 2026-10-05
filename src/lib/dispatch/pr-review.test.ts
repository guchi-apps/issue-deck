import { describe, expect, it } from "vitest";

import { describeDispatchJobKind, describeDispatchJobStatus, parseDispatchJobKind } from "./dispatch-job";
import {
  buildPrReviewActiveKey,
  isAutoMergeJobName,
  isPrReviewResumable,
  parsePrReviewSha,
  parsePrReviewVerdict,
  resolvePrReviewGateState,
  type PrReviewJobLike,
} from "./pr-review";

const job = (overrides: Partial<PrReviewJobLike>): PrReviewJobLike => ({
  status: "QUEUED",
  reviewVerdict: null,
  message: null,
  claimedByHost: null,
  targetHost: "subpc",
  ...overrides,
});

describe("resolvePrReviewGateState", () => {
  it("ジョブが無ければ missing", () => {
    expect(resolvePrReviewGateState(null)).toEqual({ state: "missing" });
  });

  it("キュー待ち・受付済み・実行中は pending で、段階を区別できる", () => {
    expect(resolvePrReviewGateState(job({ status: "QUEUED" }))).toMatchObject({ state: "pending", phase: "queued" });
    expect(resolvePrReviewGateState(job({ status: "CLAIMED", claimedByHost: "subpc-2" }))).toMatchObject({
      state: "pending",
      phase: "claimed",
      host: "subpc-2",
    });
    expect(resolvePrReviewGateState(job({ status: "RUNNING" }))).toMatchObject({ state: "pending", phase: "running" });
  });

  it("判定つきの成功は done", () => {
    expect(resolvePrReviewGateState(job({ status: "SUCCEEDED", reviewVerdict: "lgtm" }))).toEqual({
      state: "done",
      verdict: "lgtm",
    });
  });

  it("判定の無い成功・読めない判定は failed（自動マージを通さない）", () => {
    expect(resolvePrReviewGateState(job({ status: "SUCCEEDED" })).state).toBe("failed");
    expect(resolvePrReviewGateState(job({ status: "SUCCEEDED", reviewVerdict: "failed" })).state).toBe("failed");
  });

  it("失敗・時間切れ・見送りは failed で、理由（message）を伝える", () => {
    expect(resolvePrReviewGateState(job({ status: "FAILED", message: "起動前に失敗" }))).toEqual({
      state: "failed",
      reason: "起動前に失敗",
    });
    expect(resolvePrReviewGateState(job({ status: "TIMEOUT" }))).toMatchObject({ state: "failed" });
    expect(resolvePrReviewGateState(job({ status: "SKIPPED" }))).toMatchObject({ state: "failed" });
  });

  it("取り消し（古いHEAD）は stale", () => {
    expect(resolvePrReviewGateState(job({ status: "CANCELED" }))).toEqual({ state: "stale" });
  });
});

describe("活性キーと入力の検証", () => {
  it("同じPR・HEAD・agentは同じキーで、HEADが変われば別のキーになる", () => {
    const a = buildPrReviewActiveKey("o/r", 7, "a".repeat(40), "codex");
    expect(a).toBe(buildPrReviewActiveKey("o/r", 7, "a".repeat(40), "codex"));
    expect(a).not.toBe(buildPrReviewActiveKey("o/r", 7, "b".repeat(40), "codex"));
    expect(a).not.toBe(buildPrReviewActiveKey("o/r", 7, "a".repeat(40), "claude"));
  });

  it("SHAは40桁（または64桁）の16進だけ通す", () => {
    expect(parsePrReviewSha("a".repeat(40))).toBe("a".repeat(40));
    expect(parsePrReviewSha("abc123")).toBeNull();
    expect(parsePrReviewSha("A".repeat(40))).toBeNull();
    expect(parsePrReviewSha(undefined)).toBeNull();
  });

  it("判定は既知の3語だけ通す", () => {
    expect(parsePrReviewVerdict("needs-check")).toBe("needs-check");
    expect(parsePrReviewVerdict("failed")).toBeNull();
    expect(parsePrReviewVerdict(1)).toBeNull();
  });

  it("最終マージ判定を再開してよいのは確定した状態だけ（取り消しは再開しない）", () => {
    expect(isPrReviewResumable("SUCCEEDED")).toBe(true);
    expect(isPrReviewResumable("TIMEOUT")).toBe(true);
    expect(isPrReviewResumable("RUNNING")).toBe(false);
    expect(isPrReviewResumable("CANCELED")).toBe(false);
  });

  it("再利用ワークフロー経由のジョブ名から auto-merge を見分ける（fallbackは除く）", () => {
    expect(isAutoMergeJobName("review / auto-merge")).toBe(true);
    expect(isAutoMergeJobName("auto-merge")).toBe(true);
    expect(isAutoMergeJobName("review / auto-merge-fallback")).toBe(false);
    expect(isAutoMergeJobName("review / codex-review")).toBe(false);
  });
});

describe("画面の表記", () => {
  it("PR_REVIEWの種別・状態を区別して見せる", () => {
    expect(parseDispatchJobKind("pr_review")).toBe("PR_REVIEW");
    expect(describeDispatchJobKind("PR_REVIEW")).toBe("PRレビュー");
    const labels = (["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED", "FAILED", "TIMEOUT", "CANCELED"] as const).map(
      (status) => describeDispatchJobStatus(status, "PR_REVIEW").label,
    );
    expect(labels).toEqual([
      "キュー待ち",
      "サブPC受付済み",
      "レビュー実行中",
      "完了",
      "失敗",
      "タイムアウト",
      "古いHEAD（取り消し）",
    ]);
  });
});
