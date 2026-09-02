import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import {
  countMergePendingAttention,
  describeMergePendingAttention,
  isAutoMergingPullRequest,
  isPullRequestViewAttention,
} from "@/lib/merge-pending-attention";
import type { PullRequestSummary } from "@/types/pull-request";

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "タイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/1",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1",
    kind: "issue",
    linkedIssueNumber: 1,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

const REPAIR_RUN = { kind: "ci", startedAt: "2026-08-25T09:00:00.000Z", runUrl: null } as const;

const DESCRIPTION = "マージ待ちのPull Request";

describe("countMergePendingAttention（#2334）", () => {
  it("人がマージするしかないPRだけをactionRequiredに数える", () => {
    const attention = countMergePendingAttention(
      [
        pullRequest({ id: "a", number: 1 }),
        // Auto-merge有効でCI成功＝放っておけばGitHubが入れる
        pullRequest({ id: "b", number: 2, autoMergeEnabled: true }),
        // CI失敗の自動修復中＝いま動いているのはエージェント（#2072）
        pullRequest({ id: "c", number: 3, ciState: "failure", repairRun: REPAIR_RUN }),
      ],
      true,
    );

    expect(attention).toEqual({ total: 3, autoMerging: 1, repairing: 1, actionRequired: 1 });
  });

  // 待っても解消せず、人が直すしかない
  it("修復が走っていないCI失敗はactionRequiredに数える", () => {
    const attention = countMergePendingAttention(
      [pullRequest({ ciState: "failure", repairRun: null })],
      true,
    );

    expect(attention?.actionRequired).toBe(1);
  });

  // Auto-merge有効でもCIが落ちていれば入らない（人が直すしかない）
  it("Auto-merge有効でもCI失敗なら自動で進むものに数えない", () => {
    const attention = countMergePendingAttention(
      [pullRequest({ autoMergeEnabled: true, ciState: "failure" })],
      true,
    );

    expect(attention).toMatchObject({ autoMerging: 0, actionRequired: 1 });
  });

  // 母集団は「マージ待ち」ビューそのもの（`filterPullRequestsByView`）
  it("実行中のPR（CI待ち・ドラフト）は数えない", () => {
    const attention = countMergePendingAttention(
      [pullRequest({ id: "a", ciState: "pending" }), pullRequest({ id: "b", draft: true })],
      true,
    );

    expect(attention).toEqual({ total: 0, autoMerging: 0, repairing: 0, actionRequired: 0 });
  });

  it("未取得のあいだはnullを返す（0件と区別する）", () => {
    expect(countMergePendingAttention([], false)).toBeNull();
  });
});

describe("isAutoMergingPullRequest（#2334）", () => {
  it("Auto-merge有効かつCI成功のときだけ真", () => {
    expect(isAutoMergingPullRequest(pullRequest({ autoMergeEnabled: true }))).toBe(true);
    expect(isAutoMergingPullRequest(pullRequest({ autoMergeEnabled: false }))).toBe(false);
    expect(
      isAutoMergingPullRequest(pullRequest({ autoMergeEnabled: true, ciState: "pending" })),
    ).toBe(false);
  });
});

describe("isPullRequestViewAttention（#2334）", () => {
  const attention = { total: 3, autoMerging: 1, repairing: 1, actionRequired: 1 };

  it("マージ待ちに要操作のPRが残っているときだけ点ける", () => {
    expect(isPullRequestViewAttention("completed", attention)).toBe(true);
  });

  it("マージ待ちが自動で進むものだけなら点けない", () => {
    expect(
      isPullRequestViewAttention("completed", {
        total: 2,
        autoMerging: 1,
        repairing: 1,
        actionRequired: 0,
      }),
    ).toBe(false);
  });

  it("未取得では点けない", () => {
    expect(isPullRequestViewAttention("completed", null)).toBe(false);
  });

  it("すべてのPR・実行中は点けない", () => {
    expect(isPullRequestViewAttention("all", attention)).toBe(false);
    expect(isPullRequestViewAttention("in-progress", attention)).toBe(false);
  });
});

describe("describeMergePendingAttention（#2334）", () => {
  it("要操作と自動で進むものを書き分ける", () => {
    expect(
      describeMergePendingAttention(DESCRIPTION, {
        total: 3,
        autoMerging: 1,
        repairing: 1,
        actionRequired: 1,
      }),
    ).toBe(`${DESCRIPTION}（3件: 要操作1件・自動マージ待ち1件・自動修復中1件）`);
  });

  it("0件・未取得のときは説明文だけを返す", () => {
    expect(
      describeMergePendingAttention(DESCRIPTION, {
        total: 0,
        autoMerging: 0,
        repairing: 0,
        actionRequired: 0,
      }),
    ).toBe(DESCRIPTION);
    expect(describeMergePendingAttention(DESCRIPTION, null)).toBe(DESCRIPTION);
  });
});
