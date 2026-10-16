import { describe, expect, it } from "vitest";
import { describeReleaseGuidance, prepareFixReason } from "./release-review-guidance";
import type { ReleaseVerificationSummary } from "./release-verification-summary";
import type { ReleaseReviewFinding } from "./release-review-result";

const finding: ReleaseReviewFinding = { title: "入力が消える", severity: "high", detail: "", file: "queue.ts", line: 1, impact: "後続編集が失われる", evidence: "同じIDの操作を削除する", blockingReason: "利用者のデータ消失", recommendation: "送信中の操作を固定する", pullRequests: [] };
function summary(review = {}, integration = {}, mac = {}): ReleaseVerificationSummary {
  const section = { state: "passed", findings: [], suggestions: [], unverifiedScope: null };
  return { aiReview: { ...section, ...review }, integration: { ...section, ...integration }, mac: { state: "not_applicable", ...mac } } as unknown as ReleaseVerificationSummary;
}
describe("release guidance", () => {
  it("実行失敗と不具合を区別し、同時にある停止理由を隠さない", () => {
    const rows = describeReleaseGuidance(summary({ state: "failed" }, { state: "failed" }));
    expect(rows).toHaveLength(2);
    expect(rows[1].next).toContain("コードの不具合が見つかったこととは別");
  });
  it("指摘と未確認を別々に示す", () => {
    const rows = describeReleaseGuidance(summary({ state: "needs_check", findings: [finding], unverifiedScope: "外部workflow未取得" }));
    expect(rows.map(r => r.title)).toEqual(["対応判断が必要な指摘 1件", "確認できていない範囲があります"]);
    expect(rows[1].next).toContain("同じ条件で再実行");
  });
  it("改善提案だけなら判断を必須にしない", () => {
    expect(describeReleaseGuidance(summary({ suggestions: [finding] }))[0].next).toContain("判断は任意");
  });
  it.each(["running", "waiting", "invalidated", "not_run"])("%sは対応完了にしない", state => {
    expect(describeReleaseGuidance(summary({ state })).some(r => r.kind === "complete")).toBe(false);
  });
  it("Macの設定不足・実行中は対応完了にしない", () => {
    for (const state of ["needs_setup", "running", "failed", "invalidated"]) expect(describeReleaseGuidance(summary({}, {}, { state })).some(r => r.kind === "complete")).toBe(false);
  });
  it("理由案は影響・根拠・阻害理由が揃った指摘だけに作る", () => {
    expect(prepareFixReason(finding, true)).toContain(finding.evidence);
    expect(prepareFixReason(finding, false)).toBeNull();
    expect(prepareFixReason({ ...finding, evidence: null }, true)).toBeNull();
    expect(prepareFixReason({ ...finding, blockingReason: null }, true)).toBeNull();
    expect(prepareFixReason({ ...finding, impact: "x".repeat(5000) }, true)!.length).toBeLessThan(2000);
  });
});
