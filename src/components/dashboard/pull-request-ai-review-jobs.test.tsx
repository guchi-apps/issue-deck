// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PullRequestAiReviewJobsView } from "@/components/dashboard/pull-request-ai-review-jobs";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { selectPrReviewJobsForPullRequest } from "@/lib/dispatch/pr-review";

afterEach(cleanup);

const HEAD = "a".repeat(40);

function job(overrides: Partial<DispatchJobView>): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 7,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    kind: "PR_REVIEW",
    agent: "codex",
    status: "QUEUED",
    message: null,
    prNumber: 7,
    headSha: HEAD,
    reviewVerdict: null,
    createdAt: "2026-10-05T01:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    ...overrides,
  } as DispatchJobView;
}

describe("PullRequestAiReviewJobsView", () => {
  it("ジョブが無ければ何も出さない", () => {
    const { container } = render(<PullRequestAiReviewJobsView jobs={[]} headSha={HEAD} />);
    expect(container.innerHTML).toBe("");
  });

  it("状態・host・判定を区別して出す", () => {
    render(
      <PullRequestAiReviewJobsView
        jobs={[job({ status: "SUCCEEDED", reviewVerdict: "changes-requested", startedAt: "2026-10-05T01:01:00.000Z" })]}
        headSha={HEAD}
      />,
    );
    expect(screen.getByText(/Codex CLI: 完了/)).toBeTruthy();
    expect(screen.getByText(/要修正/)).toBeTruthy();
    expect(screen.getByText(/aaaaaaa/)).toBeTruthy();
  });

  it("失敗・タイムアウトは理由を本文として出す（起動前の失敗も同じ）", () => {
    render(
      <PullRequestAiReviewJobsView
        jobs={[job({ status: "TIMEOUT", message: "サブPCからの応答が途絶えたためタイムアウトしました。" })]}
        headSha={HEAD}
      />,
    );
    expect(screen.getByText(/Codex CLI: タイムアウト/)).toBeTruthy();
    expect(screen.getByText(/応答が途絶えた/)).toBeTruthy();
  });

  it("PRのHEADが進んでいれば、古いHEADとして結果を使わないことを出す", () => {
    render(
      <PullRequestAiReviewJobsView
        jobs={[job({ status: "SUCCEEDED", reviewVerdict: "lgtm" })]}
        headSha={"b".repeat(40)}
      />,
    );
    expect(screen.getByText("古いHEAD（結果は使いません）")).toBeTruthy();
  });
});

describe("selectPrReviewJobsForPullRequest", () => {
  it("同じPRのPRレビューだけを新しい順に返す", () => {
    const jobs = [
      job({ id: "old", createdAt: "2026-10-05T00:00:00.000Z" }),
      job({ id: "new", createdAt: "2026-10-05T02:00:00.000Z" }),
      job({ id: "other-pr", prNumber: 8 }),
      job({ id: "other-kind", kind: "PLAN_REVIEW" }),
      job({ id: "other-repo", repositoryFullName: "guchi-apps/other" }),
    ];
    expect(selectPrReviewJobsForPullRequest(jobs, "guchi-apps/issue-deck", 7).map((j) => j.id)).toEqual([
      "new",
      "old",
    ]);
  });
});
