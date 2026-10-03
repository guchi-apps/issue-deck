import { describe, expect, it } from "vitest";

import { resolvePullRequestReviewRound } from "@/lib/github/pull-request-review-round";

const verdict = (reviewKind: "changes-requested" | "ok", reviewedSha = "abc1234") => ({
  reviewKind,
  reviewLabel: reviewKind,
  riskKind: "none" as const,
  riskLabel: "なし",
  riskReasons: [],
  confirmLabel: null,
  reviewedSha,
});

const base = { repairRun: null, reviewPending: false, autoMergeEnabled: false, readyToMerge: false };

describe("resolvePullRequestReviewRound", () => {
  it("レビュー修正の実行中は同じPRの修正中として示す", () => {
    expect(resolvePullRequestReviewRound({ ...base, reviewVerdict: verdict("changes-requested"), headSha: "abc1234", repairRun: { kind: "review", startedAt: "2026-10-03T00:00:00Z", runUrl: null } }).state).toBe("fixing");
  });

  it("修正後に古い要修正判定だけが残る間は再レビュー中と示す", () => {
    expect(resolvePullRequestReviewRound({ ...base, reviewVerdict: verdict("changes-requested"), headSha: "def5678" }).state).toBe("re-reviewing");
  });

  it("最新コミットへの要修正は元PRで修正する状態にする", () => {
    expect(resolvePullRequestReviewRound({ ...base, reviewVerdict: verdict("changes-requested"), headSha: "abc1234" }).state).toBe("changes-requested");
  });

  it("レビューOKでマージ可能ならマージ待ちと示す", () => {
    expect(resolvePullRequestReviewRound({ ...base, reviewVerdict: verdict("ok"), headSha: "abc1234", readyToMerge: true }).state).toBe("merge-pending");
  });
});
