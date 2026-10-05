import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE, type AiReviewState } from "@/lib/github/check-rollup";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import {
  resolvePullRequestHealth,
  summarizePullRequestHealth,
} from "@/lib/pull-request-health";
import type { PullRequestSummary } from "@/types/pull-request";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OLD_HEAD = "ffffffffffffffffffffffffffffffffffffffff";

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "実装する",
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
    ciRunId: null,
    ciChecks: [],
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function withReview(
  state: AiReviewState,
  verdict: PullRequestReviewVerdict["reviewKind"] | null,
  reviewedSha: string | null = HEAD,
): Partial<PullRequestSummary> {
  return {
    mergeJudgement: {
      state: "settled",
      step: null,
      runUrl: null,
      aiReview: { state, runUrl: "https://github.com/x/y/actions/runs/1" },
    },
    reviewVerdict:
      verdict === null
        ? null
        : {
            reviewKind: verdict,
            reviewLabel: "",
            riskKind: "none",
            riskLabel: "",
            riskReasons: [],
            confirmLabel: null,
            reviewedSha,
          },
  };
}

const labelOf = (health: ReturnType<typeof resolvePullRequestHealth>, key: string) =>
  health.slots.find((slot) => slot.key === key)?.label;

describe("resolvePullRequestHealth（#4015）", () => {
  it("CI成功でもレビュー要修正・コンフリクトが同時に見える", () => {
    const health = resolvePullRequestHealth(
      pr({ ...withReview("passed", "changes-requested"), mergeable: false }),
    );
    expect(labelOf(health, "ci")).toBe("CI成功");
    expect(labelOf(health, "review")).toBe("レビュー要修正");
    expect(labelOf(health, "conflict")).toBe("コンフリクトあり");
    expect(health.categories).toEqual(
      expect.arrayContaining(["review-changes-requested", "conflict"]),
    );
    expect(health.disposition).toBe("human");
    expect(health.blocksPlainMergeWait).toBe(true);
  });

  it("CIの待機・実行・根拠なしの未完了を区別し、根拠が無ければ実行中と言わない", () => {
    const check = (status: string) => ({
      name: "build",
      status,
      conclusion: null,
      startedAt: null,
      completedAt: null,
      htmlUrl: null,
      runId: 1,
    });
    expect(labelOf(resolvePullRequestHealth(pr({ ciState: "pending", ciChecks: [check("in_progress")] })), "ci")).toBe("CI実行中");
    expect(labelOf(resolvePullRequestHealth(pr({ ciState: "pending", ciChecks: [check("queued")] })), "ci")).toBe("CI待機");
    expect(labelOf(resolvePullRequestHealth(pr({ ciState: "pending", ciChecks: [] })), "ci")).toBe("CI未完了");
    expect(labelOf(resolvePullRequestHealth(pr({ ciState: "unknown" })), "ci")).toBe("CI未確認");
  });

  it("レビュー省略・ジョブ終了だけで判定が読めないものをLGTMに見せない", () => {
    expect(labelOf(resolvePullRequestHealth(pr(withReview("skipped", null))), "review")).toBe("レビュー省略");
    expect(labelOf(resolvePullRequestHealth(pr(withReview("passed", null))), "review")).toBe("判定未記録");
    expect(labelOf(resolvePullRequestHealth(pr(withReview("passed", "ok"))), "review")).toBe("レビューLGTM");
    const failed = resolvePullRequestHealth(pr(withReview("failed", null)));
    expect(labelOf(failed, "review")).toBe("レビュー失敗");
    expect(failed.categories).toContain("review-needs-check");
  });

  it("旧HEADの判定（要修正もLGTMも）は現在の結果にせず、再検証待ちにする", () => {
    const staleNg = resolvePullRequestHealth(pr(withReview("passed", "changes-requested", OLD_HEAD)));
    expect(labelOf(staleNg, "review")).toBe("再検証待ち");
    expect(staleNg.categories).not.toContain("review-changes-requested");
    expect(staleNg.categories).toContain("revalidating");

    const staleOk = resolvePullRequestHealth(pr(withReview("passed", "ok", OLD_HEAD)));
    expect(labelOf(staleOk, "review")).toBe("再検証待ち");
  });

  it("再レビュー中と言うのは、実際にレビューが走っているときだけ", () => {
    expect(labelOf(resolvePullRequestHealth(pr(withReview("pending", "ok", OLD_HEAD))), "review")).toBe("再レビュー中");
    expect(labelOf(resolvePullRequestHealth(pr(withReview("pending", null))), "review")).toBe("レビュー実施中");
  });

  it("コンフリクトの未取得を「なし」と言わない", () => {
    expect(labelOf(resolvePullRequestHealth(pr({ mergeable: null })), "conflict")).toBe("コンフリクト判定中");
    expect(labelOf(resolvePullRequestHealth(pr({ mergeable: true })), "conflict")).toBe("コンフリクトなし");
  });

  it("自動修正中は問題の表示を残したまま、待てば進む側へ分類する", () => {
    const health = resolvePullRequestHealth(
      pr({
        ...withReview("passed", "changes-requested"),
        repairRun: { kind: "review", startedAt: "2026-10-05T00:00:00Z", runUrl: null },
      }),
    );
    expect(labelOf(health, "review")).toBe("レビュー要修正");
    expect(labelOf(health, "repair")).toBe("自動修正中");
    expect(health.disposition).toBe("auto");
  });

  it("修復系列が続いている間は再検証待ち、止まれば理由つきで人の対応に回す", () => {
    const waiting = resolvePullRequestHealth(
      pr({ ciState: "failure", autoRepair: { status: "running", round: 1, maxRounds: 3, stopReason: null } }),
    );
    expect(labelOf(waiting, "repair")).toBe("再検証待ち 1/3");
    expect(waiting.disposition).toBe("auto");

    const stopped = resolvePullRequestHealth(
      pr({
        ciState: "failure",
        autoRepair: { status: "stopped", round: 3, maxRounds: 3, stopReason: "max_rounds_reached" },
      }),
    );
    expect(labelOf(stopped, "repair")).toBe("自動修正停止");
    expect(stopped.slots.find((slot) => slot.key === "repair")?.title).toContain("上限回数");
    expect(stopped.disposition).toBe("human");

    // 問題が残っていなければ、止まった過去の系列を出さない
    expect(labelOf(resolvePullRequestHealth(pr({ autoRepair: { status: "stopped", round: 1, maxRounds: 3, stopReason: "timed_out" } })), "repair")).toBeUndefined();
  });

  it("マージ済み・クローズ済み・ドラフトは現在の状態を持たない", () => {
    for (const overrides of [{ merged: true, state: "closed" as const }, { state: "closed" as const }, { draft: true }]) {
      const health = resolvePullRequestHealth(pr({ ciState: "failure", ...overrides }));
      expect(health.slots).toEqual([]);
      expect(health.categories).toEqual([]);
    }
  });
});

describe("summarizePullRequestHealth（#4015）", () => {
  it("カテゴリごとにopen PR数を数え、同じPRは重複計上しない", () => {
    const failing = pr({ id: "a#1", ciState: "failure", mergeable: false });
    const summary = summarizePullRequestHealth([
      failing,
      failing,
      pr({ id: "a#2", ...withReview("passed", "changes-requested") }),
      pr({ id: "a#3", merged: true, state: "closed", ciState: "failure" }),
    ]);
    expect(summary.counts["ci-failed"]).toBe(1);
    expect(summary.counts.conflict).toBe(1);
    expect(summary.counts["review-changes-requested"]).toBe(1);
    expect(summary.humanCount).toBe(2);
    expect(summary.autoCount).toBe(0);
  });

  it("手が要るものと待てば進むものを重ねて数えない", () => {
    const summary = summarizePullRequestHealth([
      pr({ id: "a#1", ciState: "failure" }),
      pr({ id: "a#2", ciState: "failure", repairRun: { kind: "ci", startedAt: "2026-10-05T00:00:00Z", runUrl: null } }),
      pr({ id: "a#3", ciState: "pending" }),
    ]);
    expect(summary.humanCount).toBe(1);
    expect(summary.autoCount).toBe(2);
  });
});
