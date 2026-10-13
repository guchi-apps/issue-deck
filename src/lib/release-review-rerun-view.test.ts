import { describe, expect, it } from "vitest";

import { describeReviewRerun, mentionsOpsEvidence } from "@/lib/release-review-rerun-view";
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
    expect(view.kind === "wait" && view.prerequisites[0]).toMatchObject({ status: "pending" });
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

  it("poller更新・再起動の証跡不足は、再実行では解決しない旨を別に出す（確認済みにしない）", () => {
    const view = describeReviewRerun(
      section({ state: "needs_check", reason: "未確認範囲があります: 旧poller更新・再起動の証跡未確認" }),
      integration("passed"),
    );
    expect(view.kind === "ready" && view.opsEvidence).toContain("再実行だけでは解決しません");
  });

  it("実行失敗には運用証跡の不足を混ぜない", () => {
    const view = describeReviewRerun(section({ state: "failed", reason: "pollerの更新が必要" }), integration("passed"));
    expect(view.kind === "ready" && view.opsEvidence).toBeNull();
  });

  it("運用証跡の言及を判定する", () => {
    expect(mentionsOpsEvidence(["旧poller更新・再起動の証跡未確認"])).toBe(true);
    expect(mentionsOpsEvidence([null, "テストが未確認"])).toBe(false);
  });
});
