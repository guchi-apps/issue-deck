import { describe, expect, it } from "vitest";
import { describeReleaseGuidance, describeUnresolvableCause, prepareFixReason } from "./release-review-guidance";
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
  it("他リポジトリが原因の未確認は、汎用の未確認ではなく相手リポジトリを示す（#5378）", () => {
    const rows = describeReleaseGuidance(summary({ state: "needs_check", unverifiedScope: "利用側未確認", crossRepoUnverified: [{ repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "", reason: "" }] }));
    expect(rows.map(r => r.title)).toEqual(["他リポジトリの確認が必要です（guchi-apps/aide）"]);
    expect(rows[0].next).toContain("再実行・自動修正では解消しません");
  });
});

describe("指摘0件で止まった原因の出し分け（#5378）", () => {
  const source = { repositoryFullName: "guchi-apps/asset-manager", pullRequestNumber: 1371 };
  const cross = [
    { repository: "guchi-apps/aide", checkId: "pr_interaction", usage: "MCPが読む", reason: "削除の影響" },
    { repository: "guchi-apps/aide", checkId: "ui_truthfulness", usage: "", reason: "説明文" },
    { repository: "guchi-apps/kurashio", checkId: null, usage: "", reason: "" },
  ];
  const stage = (items: string[]) => ({ kind: "needs_check", autoReevaluated: true, items });
  it("他リポジトリだけが残れば、相手ごとに1件の下書きを出す", () => {
    const cause = describeUnresolvableCause(summary({ state: "needs_check", stage: stage(["cross_repo"]), crossRepoUnverified: cross }), source);
    expect(cause.kind).toBe("cross_repo");
    expect(cause.drafts.map(d => d.repository)).toEqual(["guchi-apps/aide", "guchi-apps/kurashio"]);
    expect(cause.drafts[0].body).toContain("削除の影響");
    expect(cause.drafts[0].body).toContain("説明文");
    expect(cause.drafts[0].searchUrl).toContain("is%3Aopen");
  });
  it("他リポジトリ以外の未確認も残るときは、そちらを先に案内する", () => {
    expect(describeUnresolvableCause(summary({ stage: stage(["cross_repo", "code_unread"]), crossRepoUnverified: cross }), source).kind).toBe("code_unread");
    const other = describeUnresolvableCause(summary({ stage: stage(["cross_repo", "check_unconfirmed"]), crossRepoUnverified: cross }), source);
    expect(other.kind).toBe("other");
    expect(other.description).toContain("guchi-apps/aide");
  });
  it("未確認の項目がすべて他リポジトリが理由なら、証跡待ちの文言に数えられても他リポジトリとして案内する", () => {
    const checks = [{ id: "pr_interaction", status: "unconfirmed", evidence: "連携先のコードが無い" }];
    const v = (extra: object[]) => summary({ stage: stage(["review_unconfirmed", "cross_repo"]), crossRepoUnverified: cross, review: { checks: [...checks, ...extra] } });
    expect(describeUnresolvableCause(v([]), source).kind).toBe("cross_repo");
    expect(describeUnresolvableCause(v([{ id: "config_migration", status: "unconfirmed", evidence: "テスト未実施" }]), source).kind).toBe("other");
  });
  it("運用作業・統合検証・その他を出し分ける", () => {
    expect(describeUnresolvableCause(summary({ stage: stage(["ops"]) }), source).kind).toBe("ops");
    expect(describeUnresolvableCause(summary({ stage: stage(["review_unconfirmed", "evidence_waiting"]) }), source).kind).toBe("evidence");
    const other = describeUnresolvableCause(summary({ stage: stage(["check_unconfirmed"]) }), source);
    expect(other).toMatchObject({ kind: "other", title: "自動修正では解消できません", drafts: [] });
  });
});
