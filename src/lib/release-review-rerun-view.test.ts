import { describe, expect, it } from "vitest";

import { describeReviewRerun } from "@/lib/release-review-rerun-view";
import type { ReleaseVerificationSection } from "@/lib/release-verification-summary";

function section(overrides: Partial<ReleaseVerificationSection> = {}): ReleaseVerificationSection {
  return {
    kind: "ai_review",
    state: "not_run",
    reason: null,
    summary: null,
    evidenceUrl: null,
    agent: null,
    updatedAt: null,
    findings: [],
    suggestions: [],
    review: null,
    affectedPullRequests: [],
    affectedFiles: [],
    reviewedFiles: null,
    totalFiles: null,
    coverage: null,
    progress: null,
    diagnostic: null,
    previousRun: null,
    ...overrides,
  };
}

const integration = (state: ReleaseVerificationSection["state"], updatedAt: string | null = null) =>
  section({ kind: "integration", state, updatedAt });

describe("describeReviewRerun", () => {
  it("合格・実行中・無効の全体レビューには再実行を出さない", () => {
    for (const state of ["passed", "running", "waiting", "invalidated", "not_run"] as const) {
      expect(describeReviewRerun(section({ state }), integration("passed"))).toEqual({ kind: "none" });
    }
  });

  it("統合検証が実行中なら結果待ちにして、再実行させない", () => {
    const view = describeReviewRerun(section({ state: "needs_check" }), integration("running"));
    expect(view).toMatchObject({ kind: "wait" });
    expect(view.kind === "wait" && view.prerequisites.find((p) => p.label === "統合検証")).toMatchObject({ status: "pending" });
  });

  it("統合検証が全体レビューより新しく終わっていれば、証跡を更新して再評価できる", () => {
    const view = describeReviewRerun(
      section({ state: "needs_check", updatedAt: "2026-10-13T09:00:00Z" }),
      integration("passed", "2026-10-13T10:51:00Z"),
    );
    expect(view).toMatchObject({ kind: "ready", buttonLabel: "全体レビューを再実行（証跡を更新）" });
  });

  it("実行失敗にも再実行を出す（従来の導線を維持）", () => {
    expect(describeReviewRerun(section({ state: "failed" }), integration("passed"))).toMatchObject({ kind: "ready" });
  });

  it("poller更新を要求していても、稼働情報が無ければ「確認できない」にし、統合検証の成功で確認済みにしない", () => {
    const view = describeReviewRerun(
      section({ state: "needs_check", reason: "未確認範囲があります: 旧poller更新・再起動の証跡未確認" }),
      integration("passed"),
    );
    expect(view.kind === "ready" && view.ops?.status).toBe("unknown");
    expect(view.kind === "ready" && view.prerequisites.find((p) => p.label === "運用状態の確認")).toMatchObject({
      status: "pending",
      text: "状態を確認できません",
    });
    expect(view.kind === "ready" && view.ops?.nextAction).not.toContain("再実行だけでは解決しません");
  });

  it("pollerへの言及だけ・互換性の確認だけなら運用状態の案内を出さない", () => {
    const view = describeReviewRerun(
      section({ state: "needs_check", reason: "未確認範囲があります: pollerとの互換性を確認済み。テストの証跡が未確認" }),
      integration("passed"),
    );
    expect(view.kind === "ready" && view.ops).toBeNull();
    expect(view.kind === "ready" && view.prerequisites.map((p) => p.label)).toEqual(["コードの確認", "統合検証"]);
  });

  it("運用の要求だけを根拠にした未確認の項目は、コードの読み残しに数えない", () => {
    const view = describeReviewRerun(
      section({
        state: "needs_check",
        review: {
          checks: [
            { id: "host_compat", status: "unconfirmed", evidence: "サブPCのpoller更新が未確認", source: "current", carriedFromHeadSha: null },
            { id: "tests", status: "unconfirmed", evidence: "テスト結果待ち", source: "current", carriedFromHeadSha: null },
          ],
        } as never,
      }),
      integration("passed"),
    );
    expect(view.kind === "ready" && view.prerequisites[0]).toMatchObject({
      label: "コードの確認",
      text: "読み残し: 未確認の対象0件・未確認の確認項目1件",
    });
  });

  it("実行失敗には運用状態を混ぜない", () => {
    const view = describeReviewRerun(section({ state: "failed", reason: "pollerの更新が必要" }), integration("passed"));
    expect(view.kind === "ready" && view.ops).toBeNull();
  });
});
