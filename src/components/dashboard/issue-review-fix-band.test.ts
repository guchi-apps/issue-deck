import { describe, expect, it } from "vitest";

import { selectReviewFixPullRequest } from "@/components/dashboard/issue-review-fix-band";
import type { IssuePullRequest } from "@/types/pull-request";

const HEAD = "3f047c8aa1b2c3d4e5f60718293a4b5c6d7e8f90";

function pr(overrides: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return {
    number: 659,
    htmlUrl: "https://github.com/o/r/pull/659",
    title: "t",
    state: "open",
    draft: false,
    merged: false,
    baseRef: "develop",
    linkedIssueNumber: 657,
    repairRun: null,
    headSha: HEAD,
    reviewVerdict: { reviewKind: "changes-requested", reviewedSha: HEAD },
    ...overrides,
  } as IssuePullRequest;
}

describe("selectReviewFixPullRequest", () => {
  it("このIssueのopenなPRで、いまのHEADに要修正・要確認があるものを選ぶ", () => {
    expect(selectReviewFixPullRequest([pr()], 657)?.number).toBe(659);
    expect(
      selectReviewFixPullRequest([pr({ reviewVerdict: { reviewKind: "needs-check", reviewedSha: HEAD } as never })], 657),
    ).not.toBeNull();
  });

  it("古い判定・LGTM・自動修正中・閉じたPR・別Issueは選ばない", () => {
    const cases: Partial<IssuePullRequest>[] = [
      { reviewVerdict: { reviewKind: "changes-requested", reviewedSha: "0".repeat(40) } as never },
      { reviewVerdict: { reviewKind: "lgtm", reviewedSha: HEAD } as never },
      { reviewVerdict: null },
      { repairRun: { kind: "review" } as never },
      { state: "closed" },
      { merged: true },
      { draft: true },
      { linkedIssueNumber: 1 },
    ];
    for (const overrides of cases) {
      expect(selectReviewFixPullRequest([pr(overrides)], 657)).toBeNull();
    }
  });
});
