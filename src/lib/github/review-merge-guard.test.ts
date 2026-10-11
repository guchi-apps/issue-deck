import { describe, expect, it } from "vitest";

import { evaluateReviewMergeGuard } from "@/lib/github/review-merge-guard";

const HEAD = "1a2b3c4d5e6f";

function body(review: string, sha?: string) {
  return [
    "本文",
    `<!-- issue-deck-verification:start review=${review} risk=none -->`,
    "## 検証結果",
    "- コードレビュー: 要修正",
    "- 機械的リスク判定: 該当なし",
    ...(sha ? [`<!-- issue-deck-verification:sha=${sha} -->`] : []),
    "<!-- issue-deck-verification:end -->",
  ].join("\n");
}

describe("evaluateReviewMergeGuard", () => {
  it("要修正（現在のHEAD）は確認なしの要求を止める", () => {
    const r = evaluateReviewMergeGuard({ body: body("changes-requested", HEAD), headSha: HEAD, acknowledgeReviewSha: undefined });
    expect(r.status).toBe("review_confirmation_required");
  });
  it("判定時点が不明（sha行なし）でも止める", () => {
    const r = evaluateReviewMergeGuard({ body: body("changes-requested"), headSha: HEAD, acknowledgeReviewSha: undefined });
    expect(r.status).toBe("review_confirmation_required");
  });
  it("このHEADへの明示確認があれば通す", () => {
    const r = evaluateReviewMergeGuard({ body: body("changes-requested", HEAD), headSha: HEAD, acknowledgeReviewSha: HEAD });
    expect(r.status).toBe("ok");
  });
  it("古いHEADへの確認は流用できず、再提示になる", () => {
    const r = evaluateReviewMergeGuard({ body: body("changes-requested", HEAD), headSha: HEAD, acknowledgeReviewSha: "old0000" });
    expect(r).toMatchObject({ status: "review_confirmation_required", acknowledgedStale: true });
  });
  it("判定の後にコミットが積まれている（stale）・問題なし・本文なしは塞がない", () => {
    expect(evaluateReviewMergeGuard({ body: body("changes-requested", "abc1234"), headSha: HEAD, acknowledgeReviewSha: undefined }).status).toBe("ok");
    expect(evaluateReviewMergeGuard({ body: body("lgtm", HEAD), headSha: HEAD, acknowledgeReviewSha: undefined }).status).toBe("ok");
    expect(evaluateReviewMergeGuard({ body: null, headSha: HEAD, acknowledgeReviewSha: undefined }).status).toBe("ok");
  });
});
