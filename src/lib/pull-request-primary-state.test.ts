import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import {
  derivePrimaryState,
  describeReleaseCandidate,
  releaseVersionFromRef,
} from "@/lib/pull-request-primary-state";
import { deriveAutoMergeOutlook } from "@/lib/pull-request-auto-merge-outlook";
import { mergeWarnings } from "@/lib/pull-request-list";
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
    expect(state.kind).toBe("review-stale");
    expect(state.reason).toContain("fffffff");
    expect(state.reason).toContain(SHA.slice(0, 7));
  });

  it("古い判定は再レビューの進み具合で、待てばよいか人の番かを分ける（#5210）", () => {
    const judgement = (reviewProgress: "queued" | "running" | "completed" | "stalled") =>
      pr({
        reviewVerdict: verdict("changes-requested", "f".repeat(40)),
        mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE, reviewProgress },
      });
    expect(derivePrimaryState(judgement("queued"))).toMatchObject({
      label: "古い判定（再レビュー待ち）",
      tone: "run",
      needsAction: false,
    });
    expect(derivePrimaryState(judgement("running"))).toMatchObject({ label: "古い判定（再レビュー中）", needsAction: false });
    expect(derivePrimaryState(judgement("completed"))).toMatchObject({ tone: "warn", needsAction: true });
    expect(derivePrimaryState(judgement("stalled"))).toMatchObject({ tone: "warn", needsAction: true });
  });

  it("最新のコミットの要修正はレビュー指摘のまま", () => {
    expect(derivePrimaryState(pr({ reviewVerdict: verdict("changes-requested") })).label).toBe("レビュー指摘");
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

describe("レビュー未実施（#5212）", () => {
  const OLD_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
  const verdict = (reviewKind: "changes-requested" | "ok", reviewedSha: string) => ({
    reviewKind,
    reviewLabel: "要修正",
    riskKind: "none" as const,
    riskLabel: "該当なし",
    riskReasons: [],
    confirmLabel: null,
    reviewedSha,
  });
  const stoppedPr = (reviewVerdict: PullRequestSummary["reviewVerdict"]) =>
    pr({
      headSha: SHA,
      ciState: "success",
      reviewVerdict,
      mergeJudgement: {
        state: "settled",
        step: null,
        runUrl: null,
        aiReview: { state: "failed", runUrl: null },
        reviewProgress: "stalled",
        reviewStopped: { job: "review-provider", reason: "stalled", url: null },
      },
    });

  it("古い要修正・古いLGTM・判定なしのどれでも未実施を人の番として出す", () => {
    for (const reviewVerdict of [verdict("changes-requested", OLD_SHA), verdict("ok", OLD_SHA), null]) {
      expect(derivePrimaryState(stoppedPr(reviewVerdict))).toMatchObject({
        kind: "review-not-run",
        label: "レビュー未実施",
        tone: "warn",
        needsAction: true,
      });
    }
  });

  it("いまのコミットの判定があれば、その判定を優先する", () => {
    expect(derivePrimaryState(stoppedPr(verdict("changes-requested", SHA)))).toMatchObject({ kind: "review-findings" });
  });

  it("マージ確認で、レビューを通っていないことを警告する", () => {
    expect(mergeWarnings(stoppedPr(null)).join("")).toContain("自動レビューを通っていません");
    expect(mergeWarnings(stoppedPr(verdict("ok", SHA))).join("")).not.toContain("自動レビューを通っていません");
  });

  it("画面の操作を示す見込みを出す", () => {
    expect(deriveAutoMergeOutlook(stoppedPr(null))).toMatchObject({ kind: "manual" });
    expect(deriveAutoMergeOutlook(stoppedPr(null))?.reason).toContain("AIレビューを再実行");
  });
});
