import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import {
  derivePrimaryState,
  describeReleaseCandidate,
  releaseVersionFromRef,
} from "@/lib/pull-request-primary-state";
import { buildReleaseCheckCells } from "@/lib/release-candidate-checks";
import type { PullRequestSummary } from "@/types/pull-request";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

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
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1",
    headSha: SHA,
    kind: "issue",
    linkedIssueNumber: 1,
    linkedIssueNumbers: [],
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
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } as PullRequestSummary;
}

const verdict = (reviewKind: string, reviewedSha: string | null = SHA) =>
  ({ reviewKind, reviewedSha, reviewLabel: null }) as unknown as PullRequestSummary["reviewVerdict"];

describe("derivePrimaryState", () => {
  it("問題が無ければマージ可能", () => {
    expect(derivePrimaryState(pr()).kind).toBe("mergeable");
  });

  it("必須チェックが待機中ならマージ可能にせず、チェック名と説明を出す（#4884）", () => {
    const primary = derivePrimaryState(
      pr({
        autoMergeEnabled: true,
        unmetRequiredChecks: [{ name: "issue-deck/ios-precheck", state: "pending", description: "iOS修復待ち" }],
      }),
    );
    expect(primary.kind).toBe("required-check");
    expect(primary.label).toBe("必須チェック待ち");
    expect(primary.reason).toContain("issue-deck/ios-precheck（待機中: iOS修復待ち）");
    expect(primary.needsAction).toBe(false);
  });

  it("必須チェックが失敗していれば対応が要る状態にする（#4884）", () => {
    const primary = derivePrimaryState(
      pr({
        unmetRequiredChecks: [
          { name: "ci / test", state: "missing", description: null },
          { name: "issue-deck/ci-gate", state: "failure", description: null },
        ],
      }),
    );
    expect(primary.label).toBe("必須チェック失敗");
    expect(primary.reason).toContain("ci / test（未実行）、issue-deck/ci-gate（失敗）");
    expect(primary.needsAction).toBe(true);
  });

  it("必須チェックがすべて成功・調べていなければ従来どおりマージ可能", () => {
    expect(derivePrimaryState(pr({ unmetRequiredChecks: [] })).kind).toBe("mergeable");
    expect(derivePrimaryState(pr({ unmetRequiredChecks: null })).kind).toBe("mergeable");
  });

  it("CI失敗・競合・レビュー指摘・修正中・判定中を区別する", () => {
    expect(derivePrimaryState(pr({ ciState: "failure" })).kind).toBe("ci-failed");
    expect(derivePrimaryState(pr({ mergeable: false })).kind).toBe("conflict");
    expect(derivePrimaryState(pr({ reviewVerdict: verdict("changes-requested") })).kind).toBe("review-findings");
    expect(
      derivePrimaryState(
        pr({ ciState: "failure", repairRun: { kind: "ci", startedAt: "2026-08-01T00:00:00Z", runUrl: null } }),
      ).kind,
    ).toBe("repairing");
    expect(
      derivePrimaryState(
        pr({ mergeJudgement: { state: "pending", step: "claude-review", runUrl: null, aiReview: AI_REVIEW_NONE } }),
      ).kind,
    ).toBe("judging");
    expect(derivePrimaryState(pr({ ciState: "pending" })).kind).toBe("ci-running");
  });

  it("古いheadのレビュー指摘を現在の指摘として出さない", () => {
    const state = derivePrimaryState(pr({ reviewVerdict: verdict("changes-requested", "f".repeat(40)) }));
    // 既存のマージ保留（積まれたコミットを明示する）は残るが、「レビュー指摘」とは言わない
    expect(state.kind).not.toBe("review-findings");
    expect(state.reason).toContain("コミットが積まれています");
  });

  it("読めない値を成功へ倒さない", () => {
    expect(derivePrimaryState(pr({ ciState: "unknown" })).kind).toBe("unknown");
    expect(derivePrimaryState(pr({ mergeable: null })).kind).toBe("unknown");
  });

  it("終端・ドラフトを区別する", () => {
    expect(derivePrimaryState(pr({ merged: true, state: "closed" })).kind).toBe("merged");
    expect(derivePrimaryState(pr({ state: "closed" })).kind).toBe("closed");
    expect(derivePrimaryState(pr({ draft: true })).kind).toBe("draft");
  });

  it("修復が起動できる種類だけを返す", () => {
    expect(derivePrimaryState(pr({ ciState: "failure" })).repairKinds).toEqual(["ci"]);
    expect(derivePrimaryState(pr({ mergeable: false })).repairKinds).toEqual(["conflict"]);
  });

  it("マージ前の確認が要る保留を区別する", () => {
    const state = derivePrimaryState(pr({ linkedIssueCheckUser: true, linkedIssueCheckReason: "merge" }));
    expect(state.kind).toBe("merge-held");
    expect(state.needsAction).toBe(true);
  });

  it("リリース候補の有無は通常PRの代表状態に影響しない", () => {
    const none = buildReleaseCheckCells({ source: { status: "loaded", candidates: [] }, pullRequestNumber: 1, nowMs: 0 });
    expect(describeReleaseCandidate(none)).toEqual({ status: "none" });
    expect(derivePrimaryState(pr()).kind).toBe("mergeable");
  });
});

describe("describeReleaseCandidate", () => {
  it("取得中・取得不可・候補なし・候補ありを区別する", () => {
    expect(
      describeReleaseCandidate(buildReleaseCheckCells({ source: { status: "loading" }, pullRequestNumber: 1, nowMs: 0 })),
    ).toEqual({ status: "loading" });
    expect(
      describeReleaseCandidate(
        buildReleaseCheckCells({ source: { status: "error", message: "x" }, pullRequestNumber: 1, nowMs: 0 }),
      ),
    ).toEqual({ status: "error" });
  });

  it("版をブランチ名から取り出す", () => {
    expect(releaseVersionFromRef("release-main/v8.54.0")).toBe("v8.54.0");
    expect(releaseVersionFromRef("issue-1")).toBeNull();
  });
});
