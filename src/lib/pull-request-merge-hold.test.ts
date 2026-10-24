import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import { deriveMergeHold, needsReviewMergeConfirmation } from "@/lib/pull-request-merge-hold";
import type { PullRequestSummary } from "@/types/pull-request";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "t",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/1",
    authorLogin: "guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1",
    headSha: HEAD,
    kind: "issue",
    linkedIssueNumber: 1,
    linkedIssueNumbers: [1],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  } as PullRequestSummary;
}

const verdict = (reviewKind: "changes-requested" | "needs-check" | "ok", reviewedSha: string | null) =>
  ({
    reviewKind,
    reviewLabel: "要修正",
    riskKind: "none",
    riskLabel: "なし",
    riskReasons: [],
    confirmLabel: null,
    reviewedSha,
  }) as PullRequestSummary["reviewVerdict"];

describe("deriveMergeHold", () => {
  it("対応Issueを特定できないPR（#4372相当）は理由が確定した保留になる", () => {
    const hold = deriveMergeHold(pr({ kind: "other", linkedIssueNumber: null, linkedIssueNumbers: [] }));
    expect(hold.status).toBe("held");
    expect(hold.reasons[0].text).toBe("対応Issueを特定できないPRで、自動レビューの「問題なし」が得られていません");
  });

  it("対応Issueが00.check-user付き（#697相当）なら、Issue番号つきのユーザー確認待ち", () => {
    const hold = deriveMergeHold(
      pr({ linkedIssueNumber: 696, linkedIssueCheckUser: true, linkedIssueCheckReason: "merge" }),
    );
    expect(hold.reasons[0]).toMatchObject({ kind: "check-user", issueNumber: 696 });
    expect(hold.reasons[0].text).toContain("Issue #696");
  });

  it("レビューが要修正なら理由に加わり、複数理由は全件並ぶ", () => {
    const hold = deriveMergeHold(
      pr({ linkedIssueNumber: null, reviewVerdict: verdict("changes-requested", HEAD) }),
    );
    expect(hold.reasons.map((r) => r.kind)).toEqual(["issue-unknown", "review"]);
  });

  it("判定ジョブが走っている間は保留確定とせず pending", () => {
    const hold = deriveMergeHold(
      pr({ mergeJudgement: { state: "pending", step: "claude-review", runUrl: null, aiReview: AI_REVIEW_NONE } }),
    );
    expect(hold.status).toBe("pending");
  });

  it("判定を読めず理由も無いなら unknown（成功とも保留とも言わない）", () => {
    const hold = deriveMergeHold(
      pr({ mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE } }),
    );
    expect(hold.status).toBe("unknown");
  });

  it("理由が無く判定済みなら none", () => {
    expect(deriveMergeHold(pr()).status).toBe("none");
  });
});

describe("needsReviewMergeConfirmation", () => {
  it("要修正かつ現在のHEADへの判定、または判定時点が不明なら true", () => {
    expect(needsReviewMergeConfirmation(pr({ reviewVerdict: verdict("changes-requested", HEAD) }))).toBe(true);
    expect(needsReviewMergeConfirmation(pr({ reviewVerdict: verdict("needs-check", null) }))).toBe(true);
  });
  it("判定の後にコミットが積まれている・問題なしなら false", () => {
    expect(needsReviewMergeConfirmation(pr({ reviewVerdict: verdict("changes-requested", "deadbeef") }))).toBe(false);
    expect(needsReviewMergeConfirmation(pr({ reviewVerdict: verdict("ok", HEAD) }))).toBe(false);
  });
});
