// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestFixIssueBar } from "@/components/dashboard/pull-request-fix-issue-bar";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import type { Issue } from "@/types/issue";
import type { PullRequestEvent, PullRequestSummary } from "@/types/pull-request";

const REVIEWED_SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const HEAD_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

function verdict(overrides: Partial<PullRequestReviewVerdict> = {}): PullRequestReviewVerdict {
  return {
    reviewKind: "changes-requested",
    reviewLabel: "要修正",
    riskKind: "none",
    riskLabel: "該当なし",
    riskReasons: [],
    confirmLabel: "必要（自動マージはスキップされます）",
    reviewedSha: null,
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#3168",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 3168,
    title: "マージ待ちPRを既定3件まで畳む",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/3168",
    authorLogin: "guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-3165",
    headSha: HEAD_SHA,
    kind: "issue",
    linkedIssueNumber: 3165,
    linkedIssueNumbers: [3165],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: verdict(),
    releaseVerification: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

/** 自動レビューがPRへ投稿した総評コメント（判定マーカー付き） */
function reviewComment(sha: string): PullRequestEvent {
  return {
    id: "comment-1",
    kind: "comment",
    authorLogin: "claude[bot]",
    body: `## 気になった点\n\n直してください。\n\n<!-- issue-deck-review-verdict:changes-requested sha=${sha} -->`,
    createdAt: "2026-09-19T01:00:00.000Z",
    reviewState: null,
    path: null,
    line: null,
  };
}

function renderBar(
  pullRequest: PullRequestSummary,
  events: PullRequestEvent[] = [],
  options: { existingFixIssue?: Pick<Issue, "number" | "htmlUrl"> | null } = {},
) {
  render(
    <PullRequestFixIssueBar
      pullRequest={pullRequest}
      events={events}
      onCreate={vi.fn()}
      repositoryFullName={pullRequest.repositoryFullName}
      issueSuggestions={[]}
      existingFixIssue={options.existingFixIssue}
    />,
  );
}

describe("PullRequestFixIssueBar の判定の鮮度（#3172）", () => {
  afterEach(cleanup);

  it("最新のコミットに対する判定なら、そのことを添える", () => {
    renderBar(
      makePullRequest({ reviewVerdict: verdict({ reviewedSha: HEAD_SHA }) }),
    );

    expect(screen.getByText(/自動レビューが「要修正」と判定しています/)).toBeTruthy();
    expect(screen.getByText(/最新のコミット/)).toBeTruthy();
    expect(screen.getByText(HEAD_SHA.slice(0, 7))).toBeTruthy();
  });

  it("判定の後にコミットが積まれていれば、時制を変えて注記する", () => {
    renderBar(
      makePullRequest({ reviewVerdict: verdict({ reviewedSha: REVIEWED_SHA }) }),
    );

    expect(screen.getByText(/自動レビューが「要修正」と判定していました/)).toBeTruthy();
    expect(screen.getByText(/この判定の後にコミットが積まれています/)).toBeTruthy();
    expect(screen.getByText(REVIEWED_SHA.slice(0, 7))).toBeTruthy();
    expect(screen.getByText(HEAD_SHA.slice(0, 7))).toBeTruthy();
  });

  it("本文に判定時点の記録が無ければ、レビューコメントのマーカーで補う", () => {
    renderBar(makePullRequest(), [reviewComment(REVIEWED_SHA)]);

    expect(screen.getByText(/この判定の後にコミットが積まれています/)).toBeTruthy();
    expect(screen.getByText(REVIEWED_SHA.slice(0, 7))).toBeTruthy();
  });

  it("再レビューが走っているあいだは、待てば更新されることを言う", () => {
    renderBar(
      makePullRequest({
        reviewVerdict: verdict({ reviewedSha: REVIEWED_SHA }),
        mergeJudgement: { state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      }),
    );

    expect(screen.getByText(/いま最新のコミットをレビューし直しています/)).toBeTruthy();
  });

  it("どこにも記録が無ければ、鮮度を言わない（従来どおりの見た目）", () => {
    renderBar(makePullRequest());

    expect(screen.getByText(/自動レビューが「要修正」と判定しています/)).toBeTruthy();
    expect(screen.queryByText(/この判定の後にコミットが積まれています/)).toBeNull();
    expect(screen.queryByText(/最新のコミット/)).toBeNull();
  });
});

describe("PullRequestFixIssueBar の既存修正Issueへの気づかせ（#3331）", () => {
  afterEach(cleanup);

  it("既存の修正Issueがあれば、起票ボタンをそのIssueへのリンクへ切り替える", () => {
    renderBar(makePullRequest(), [], {
      existingFixIssue: { number: 3001, htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/3001" },
    });

    const link = screen.getByRole("link", { name: /起票済み（#3001）/ });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/3001");
    expect(screen.queryByRole("button", { name: /修正Issueを起案/ })).toBeNull();
  });

  it("既存の修正Issueが無ければ、従来どおり起票ボタンを出す", () => {
    renderBar(makePullRequest(), [], { existingFixIssue: null });

    expect(screen.getByRole("button", { name: /修正Issueを起案/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /起票済み/ })).toBeNull();
  });
});

describe("PullRequestFixIssueBar の自動修正中の表示（#3363）", () => {
  afterEach(cleanup);

  it("レビュー指摘の自動修正が走っていれば、放っておけば片付くことを添える", () => {
    renderBar(
      makePullRequest({
        repairRun: { kind: "review", startedAt: "2026-09-19T01:00:00.000Z", runUrl: null },
      }),
    );

    expect(screen.getByText(/自動修正に回しています/)).toBeTruthy();
  });

  it("CI失敗の自動修正では出さない（帯が語るのはレビュー指摘のことだけ）", () => {
    renderBar(
      makePullRequest({
        repairRun: { kind: "ci", startedAt: "2026-09-19T01:00:00.000Z", runUrl: null },
      }),
    );

    expect(screen.queryByText(/自動修正に回しています/)).toBeNull();
  });
});
