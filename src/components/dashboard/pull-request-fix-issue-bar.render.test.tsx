// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestFixIssueBar } from "@/components/dashboard/pull-request-fix-issue-bar";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null, ciChecks: [], id: "guchi-apps/issue-deck#3168", repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false, number: 3168, title: "マージ待ちPRを既定3件まで畳む",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/3168", authorLogin: "guchi", draft: false,
    state: "open", merged: false, mergedAt: null, baseRef: "develop", headRef: "issue-3165",
    headSha: "9f8e7d6c5b4a39281706f5e4d3c1b098765432", kind: "issue", linkedIssueNumber: 3165,
    linkedIssueNumbers: [3165], autoMergeEnabled: false, linkedIssueCheckUser: false, linkedIssueCheckReason: null,
    ciState: "success", mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true, repairWorkflowAvailability: {}, repairRun: null, reviewVerdict: null, releaseVerification: null,
    createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", ...overrides,
  };
}

function renderBar(pullRequest: PullRequestSummary, existingFixIssue: Pick<Issue, "number" | "htmlUrl"> | null = null) {
  render(<PullRequestFixIssueBar pullRequest={pullRequest} events={[]} onCreate={vi.fn()} repositoryFullName={pullRequest.repositoryFullName} issueSuggestions={[]} existingFixIssue={existingFixIssue} />);
}

describe("PullRequestFixIssueBar の例外操作（#3970）", () => {
  afterEach(cleanup);

  it("レビュー要修正でも通常の修復と混同しない中立の別課題操作を出す", () => {
    renderBar(makePullRequest({ reviewVerdict: { reviewKind: "changes-requested", reviewLabel: "要修正", riskKind: "none", riskLabel: "該当なし", riskReasons: [], confirmLabel: null, reviewedSha: null } }));

    expect(screen.getByText("現在のPRの範囲外なら、別課題として起票できます。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "別課題としてIssue化" })).toBeTruthy();
    expect(screen.queryByText(/自動レビューが/)).toBeNull();
  });

  it("既存の別課題があれば、そのIssueへのリンクを出す", () => {
    renderBar(makePullRequest(), { number: 3001, htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/3001" });

    const link = screen.getByRole("link", { name: /別課題として起票済み（#3001）/ });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/3001");
    expect(screen.queryByRole("button", { name: /別課題としてIssue化/ })).toBeNull();
  });
});
