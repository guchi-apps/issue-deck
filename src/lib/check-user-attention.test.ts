import { describe, expect, it } from "vitest";

import {
  formatCheckUserListCount,
  isCheckUserWaitingForAgent,
  selectCheckUserRunningIssueIds,
} from "@/lib/check-user-attention";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

const REPO = "guchi-apps/shopping-list";
const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function label(name: string) {
  return { name, color: "ffffff", description: null };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-100",
    number: 100,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [label("00.check-user"), label("01.check-merge")],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: "2026-08-22T01:00:00.000Z",
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${REPO}/issues/100`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: `${REPO}#146`,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    number: 146,
    title: "PRのタイトル",
    htmlUrl: `https://github.com/${REPO}/pull/146`,
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-100",
    kind: "issue",
    linkedIssueNumber: 100,
    linkedIssueNumbers: [100],
    autoMergeEnabled: false,
    linkedIssueCheckUser: true,
    linkedIssueCheckReason: "merge",
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-100",
    repositoryFullName: REPO,
    issueNumber: 100,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-22T00:00:00.000Z",
    lastReportedAt: new Date(NOW - 10_000).toISOString(),
    activity: "WORKING",
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof isCheckUserWaitingForAgent>[1]> = {}) {
  return { pullRequests: [], sessions: [], now: NOW, ...overrides };
}

describe("isCheckUserWaitingForAgent", () => {
  it("00.check-userが付いていなければ常にfalse", () => {
    expect(
      isCheckUserWaitingForAgent(makeIssue({ labels: [] }), {
        ...context({ pullRequests: [makePullRequest({ ciState: "pending" })] }),
      }),
    ).toBe(false);
  });

  it("対応PRのCIが実行中なら実行中とみなす", () => {
    expect(
      isCheckUserWaitingForAgent(
        makeIssue(),
        context({ pullRequests: [makePullRequest({ ciState: "pending" })] }),
      ),
    ).toBe(true);
  });

  it("自動マージ可否の判定中も実行中とみなす（#2081と同じ判定）", () => {
    const pullRequest = makePullRequest({
      mergeJudgement: {
        state: "pending",
        step: null,
        runUrl: null,
        aiReview: AI_REVIEW_NONE,
      },
    });
    expect(
      isCheckUserWaitingForAgent(makeIssue(), context({ pullRequests: [pullRequest] })),
    ).toBe(true);
  });

  it("CIが確定していて判定も終わっていれば実行中ではない", () => {
    expect(
      isCheckUserWaitingForAgent(makeIssue(), context({ pullRequests: [makePullRequest()] })),
    ).toBe(false);
  });

  it("対応PRが無くても、サブPCのセッションが作業中なら実行中とみなす", () => {
    expect(
      isCheckUserWaitingForAgent(
        makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] }),
        context({ sessions: [makeSession()] }),
      ),
    ).toBe(true);
  });

  it("セッションが入力待ち・終了済み・報告が古いものは実行中ではない", () => {
    const plan = makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] });
    expect(
      isCheckUserWaitingForAgent(
        plan,
        context({ sessions: [makeSession({ activity: "WAITING_INPUT" })] }),
      ),
    ).toBe(false);
    expect(
      isCheckUserWaitingForAgent(plan, context({ sessions: [makeSession({ state: "EXITED" })] })),
    ).toBe(false);
    expect(
      isCheckUserWaitingForAgent(
        plan,
        context({
          sessions: [makeSession({ lastReportedAt: new Date(NOW - 10 * 60 * 1000).toISOString() })],
        }),
      ),
    ).toBe(false);
  });

  it("別Issueのセッションは材料にしない", () => {
    expect(
      isCheckUserWaitingForAgent(
        makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] }),
        context({ sessions: [makeSession({ issueNumber: 999 })] }),
      ),
    ).toBe(false);
  });
});

describe("selectCheckUserRunningIssueIds", () => {
  it("実行中のIssueだけを集める", () => {
    const running = makeIssue({ id: "running", number: 100 });
    const actionable = makeIssue({
      id: "actionable",
      number: 101,
      htmlUrl: `https://github.com/${REPO}/issues/101`,
    });
    const ids = selectCheckUserRunningIssueIds(
      [running, actionable],
      context({ pullRequests: [makePullRequest({ ciState: "pending" })] }),
    );
    expect([...ids]).toEqual(["running"]);
  });
});

describe("formatCheckUserListCount", () => {
  it("実行中が無ければnull（呼び出し側が今までどおりの件数を出す）", () => {
    expect(formatCheckUserListCount(3, 0)).toBeNull();
  });

  it("実行中があれば、メニューと同じ件数に内訳を添える", () => {
    expect(formatCheckUserListCount(3, 1)).toBe("2件・実行中1件");
  });

  it("全件が実行中でも0件を下回らない", () => {
    expect(formatCheckUserListCount(2, 3)).toBe("0件・実行中3件");
  });
});
