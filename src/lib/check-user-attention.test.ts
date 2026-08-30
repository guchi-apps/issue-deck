import { describe, expect, it } from "vitest";

import {
  formatCheckUserListCount,
  isCheckUserWaitingForAgent,
  selectCheckUserRunningIssueIds,
} from "@/lib/check-user-attention";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import type { SessionQuestionRequestView } from "@/lib/dispatch/session-question-request";
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
    codexThreadKnown: null,
    ...overrides,
  };
}

function makePlanRequest(
  overrides: Partial<SessionPlanRequestView> = {},
): SessionPlanRequestView {
  return {
    id: "plan-1",
    repositoryFullName: REPO,
    issueNumber: 100,
    hostName: "subpc",
    plan: "## 要約",
    status: "WAITING",
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 29 * 60 * 1000).toISOString(),
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

function makeQuestionRequest(
  overrides: Partial<SessionQuestionRequestView> = {},
): SessionQuestionRequestView {
  return {
    id: "question-1",
    repositoryFullName: REPO,
    issueNumber: 100,
    hostName: "subpc",
    questions: [],
    answers: null,
    status: "WAITING",
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString(),
    decidedAt: null,
    delivered: false,
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

  it("計画の承認待ちがあれば、セッションが作業中でも実行中ではない（#2238）", () => {
    const issue = makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] });
    expect(
      isCheckUserWaitingForAgent(
        issue,
        context({ sessions: [makeSession()], planRequests: [makePlanRequest()] }),
      ),
    ).toBe(false);
  });

  it("質問の回答待ちがあれば、セッションが作業中でも実行中ではない（#2238）", () => {
    const issue = makeIssue({ labels: [label("00.check-user"), label("01.check-input")] });
    expect(
      isCheckUserWaitingForAgent(
        issue,
        context({ sessions: [makeSession()], questionRequests: [makeQuestionRequest()] }),
      ),
    ).toBe(false);
  });

  it("対応PRのCIが実行中でも、答えを待っているなら実行中ではない（#2238）", () => {
    expect(
      isCheckUserWaitingForAgent(
        makeIssue(),
        context({
          pullRequests: [makePullRequest({ ciState: "pending" })],
          planRequests: [makePlanRequest()],
        }),
      ),
    ).toBe(false);
    expect(
      isCheckUserWaitingForAgent(
        makeIssue(),
        context({
          pullRequests: [makePullRequest({ ciState: "pending" })],
          questionRequests: [makeQuestionRequest()],
        }),
      ),
    ).toBe(false);
  });

  it("答えが済んだ・別Issueの待ちは材料にしない（#2238）", () => {
    const issue = makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] });
    expect(
      isCheckUserWaitingForAgent(
        issue,
        context({
          sessions: [makeSession()],
          planRequests: [
            makePlanRequest({
              status: "APPROVED",
              decidedAt: new Date(NOW - 1_000).toISOString(),
            }),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isCheckUserWaitingForAgent(
        issue,
        context({ sessions: [makeSession()], planRequests: [makePlanRequest({ issueNumber: 999 })] }),
      ),
    ).toBe(true);
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

  it("計画・質問の待ちを抱えた2件は、セッションが作業中でも実行中に数えない（#2238）", () => {
    // #2238の再現。どちらもサブPCのセッションが`WORKING`のまま残っており、
    // 待ちを見ないと2件とも実行中に落ちて左メニューの件数が0になっていた
    const planIssue = makeIssue({
      id: "plan",
      number: 2236,
      labels: [label("00.check-user"), label("01.check-plan")],
    });
    const questionIssue = makeIssue({
      id: "question",
      number: 2237,
      labels: [label("00.check-user"), label("01.check-input")],
    });
    const sessions = [makeSession({ issueNumber: 2236 }), makeSession({ issueNumber: 2237 })];

    expect([
      ...selectCheckUserRunningIssueIds([planIssue, questionIssue], context({ sessions })),
    ]).toEqual(["plan", "question"]);

    expect([
      ...selectCheckUserRunningIssueIds(
        [planIssue, questionIssue],
        context({
          sessions,
          planRequests: [makePlanRequest({ issueNumber: 2236 })],
          questionRequests: [makeQuestionRequest({ issueNumber: 2237 })],
        }),
      ),
    ]).toEqual([]);
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

  // #2398: 保留中は一覧から外してあるので、listedCountに入っていない。差ではなくそのまま足す
  it("保留中があれば内訳に添える", () => {
    expect(formatCheckUserListCount(2, 0, 2)).toBe("2件・保留中2件");
  });

  it("実行中と保留中が両方あれば並べる", () => {
    expect(formatCheckUserListCount(3, 1, 2)).toBe("2件・実行中1件・保留中2件");
  });

  it("保留中も実行中も無ければ今までどおりnull", () => {
    expect(formatCheckUserListCount(3, 0, 0)).toBeNull();
  });
});
