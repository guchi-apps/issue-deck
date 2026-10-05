import { describe, expect, it } from "vitest";

import {
  buildDevelopmentSummary,
  computeScreenNavCounts,
  type SummaryInput,
} from "@/lib/aide-development-summary";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { buildSnoozeMap } from "@/lib/snooze";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

const NOW = new Date("2026-10-05T03:00:00.000Z");

let seq = 0;
function issue(overrides: Partial<Issue> & { repositoryFullName?: string; number?: number }): Issue {
  seq += 1;
  const repositoryFullName = overrides.repositoryFullName ?? "o/a";
  const number = overrides.number ?? seq;
  return {
    id: `id-${repositoryFullName}-${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "me" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${repositoryFullName}/issues/${number}`,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

const label = (name: string) => ({ name, color: "000000", description: null });

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    now: NOW,
    repositories: [
      { fullName: "o/a", archived: false, hidden: false },
      { fullName: "o/b", archived: false, hidden: false },
    ],
    issues: [],
    currentUserLogin: "me",
    snoozes: buildSnoozeMap([]),
    reservations: [],
    nextWindow: { enabled: true, window: null, pausedAgents: {} },
    jobs: [],
    jobHeartbeats: {},
    sessions: [],
    planRequests: [],
    questionRequests: [],
    pullRequests: [],
    failedPullRequestRepositories: [],
    deployEvidence: null,
    period: { from: new Date("2026-09-28T00:00:00.000Z"), to: NOW },
    oldestClosedAtInCache: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function job(overrides: Partial<DispatchJobView>): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "o/a",
    issueNumber: 1,
    kind: "LAUNCH",
    status: "FAILED",
    message: null,
    createdAt: "2026-10-05T01:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: "2026-10-05T01:10:00.000Z",
    ...overrides,
  } as DispatchJobView;
}

describe("buildDevelopmentSummary: 画面の件数との一致", () => {
  it("未着手・実行中・確認待ち・手作業待ち・本番反映待ちが画面の左メニューの件数と一致する", () => {
    const issues = [
      issue({ number: 1 }),
      issue({ number: 2, projectStatus: "Implementation" }),
      issue({ number: 3, labels: [label("00.check-user"), label("01.check-plan")] }),
      issue({ number: 4, labels: [label("71.manual-step")] }),
      issue({ number: 5, projectStatus: "Develop", repositoryFullName: "o/b" }),
      issue({ number: 6, projectStatus: "Release", repositoryFullName: "o/b" }),
    ];
    const i = input({ issues });
    const summary = buildDevelopmentSummary(i);
    const screen = computeScreenNavCounts(i, new Set(), new Set());

    expect(summary.totals.notStarted.issues).toBe(screen["not-started"]);
    expect(summary.totals.inProgress.issues).toBe(screen["in-progress"]);
    expect(summary.totals.checkUser.issues).toBe(screen["check-user"]);
    expect(summary.totals.manualStep.actionableIssues).toBe(screen["manual-step"]);
    expect(summary.totals.deployment.awaitingMainIssues + summary.totals.deployment.mainMergeInProgressIssues).toBe(
      screen["release-pending"],
    );
    expect(summary.totals.checkUser.byReason).toEqual({ plan: 1 });
  });

  it("リポジトリ別の合計が全体と一致し、確認待ちのリポジトリ絞り込みで全体を重複させない", () => {
    const issues = [
      issue({ number: 1, labels: [label("00.check-user")] }),
      issue({ number: 2, repositoryFullName: "o/b", labels: [label("00.check-user")] }),
      issue({ number: 3, repositoryFullName: "o/b" }),
    ];
    const summary = buildDevelopmentSummary(input({ issues }));

    expect(summary.totals.checkUser.issues).toBe(2);
    expect(summary.byRepository["o/a"].checkUser.issues).toBe(1);
    expect(summary.byRepository["o/b"].checkUser.issues).toBe(1);
    expect(summary.totals.notStarted.issues).toBe(
      summary.byRepository["o/a"].notStarted.issues + summary.byRepository["o/b"].notStarted.issues,
    );
  });

  it("保留中のIssueはどの区分からも外れ、母集団の件数は保留数として別に返る", () => {
    const issues = [issue({ number: 1 }), issue({ number: 2 })];
    const summary = buildDevelopmentSummary(
      input({
        issues,
        snoozes: buildSnoozeMap([{ kind: "issue", repositoryFullName: "o/a", number: 1, until: null }]),
      }),
    );

    expect(summary.totals.notStarted.issues).toBe(1);
    expect(summary.population.snoozedIssues).toBe(1);
  });

  it("アーカイブ・非表示のリポジトリは母集団から外れ、除外したことを返す", () => {
    const summary = buildDevelopmentSummary(
      input({
        repositories: [
          { fullName: "o/a", archived: false, hidden: false },
          { fullName: "o/old", archived: true, hidden: false },
          { fullName: "o/hide", archived: false, hidden: true },
        ],
        issues: [issue({ number: 1 }), issue({ number: 2, repositoryFullName: "o/old" }), issue({ number: 3, repositoryFullName: "o/hide" })],
      }),
    );

    expect(summary.totals.notStarted.issues).toBe(1);
    expect(summary.population.excludedArchived).toEqual(["o/old"]);
    expect(summary.population.excludedHidden).toEqual(["o/hide"]);
    expect(Object.keys(summary.byRepository)).toEqual(["o/a"]);
  });
});

describe("予約", () => {
  const reservation = {
    id: "r1",
    repositoryFullName: "o/a",
    issueNumber: 1,
    agent: "claude",
    targetHost: "subpc",
    claudeModel: null,
    codexModel: null,
    createdAt: new Date("2026-10-04T00:00:00.000Z"),
    reservedResetsAt: null,
  };

  it("予約済みIssueは未着手から除外され、予約として数える（単位を分ける）", () => {
    const summary = buildDevelopmentSummary(
      input({ issues: [issue({ number: 1 }), issue({ number: 2 })], reservations: [reservation] }),
    );

    expect(summary.totals.notStarted.issues).toBe(1);
    expect(summary.totals.reserved).toEqual({ reservations: 1, issues: 1 });
    expect(summary.reservation.byAgent).toEqual({ claude: 1 });
  });

  it("次枠実行がOFFなら起動を妨げる条件として返し、問題区分にも載る", () => {
    const summary = buildDevelopmentSummary(
      input({
        issues: [issue({ number: 1 })],
        reservations: [reservation],
        nextWindow: { enabled: false, window: null, pausedAgents: { codex: "usage_limit" } },
      }),
    );

    expect(summary.reservation.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("OFF"), expect.stringContaining("codex")]),
    );
    expect(summary.items.problems.some((p) => p.reasonCode === "reservation-blocked")).toBe(true);
  });
});

describe("手作業待ち", () => {
  it("別リポジトリの前提が未完了なら前提待ちで、リポジトリ別集計でも前提を失わない", () => {
    const prerequisite = issue({ number: 5, repositoryFullName: "o/b" });
    const manual = issue({
      number: 1,
      labels: [label("71.manual-step")],
      body: "## 前提条件\n\n- 先に完了している必要があるIssue・PR: o/b#5\n",
    });
    const summary = buildDevelopmentSummary(input({ issues: [manual, prerequisite] }));

    expect(summary.byRepository["o/a"].manualStep).toEqual({
      actionableIssues: 0,
      waitingForPrerequisitesIssues: 1,
    });
    expect(summary.totals.manualStep.actionableIssues).toBe(0);
  });
});

describe("問題・停止", () => {
  it("最新のジョブが失敗しているIssueだけを数える（後続ジョブが成功していれば数えない）", () => {
    const issues = [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3, state: "closed", closedAt: "2026-10-04T00:00:00.000Z" })];
    const summary = buildDevelopmentSummary(
      input({
        issues,
        jobs: [
          job({ id: "j1", issueNumber: 1, status: "FAILED", createdAt: "2026-10-05T00:00:00.000Z" }),
          job({ id: "j2", issueNumber: 2, status: "FAILED", createdAt: "2026-10-04T00:00:00.000Z" }),
          job({ id: "j3", issueNumber: 2, status: "SUCCEEDED", createdAt: "2026-10-05T00:00:00.000Z" }),
          job({ id: "j4", issueNumber: 3, status: "FAILED" }),
        ],
      }),
    );

    expect(summary.items.problems.map((p) => p.number)).toEqual([1]);
    expect(summary.totals.problems.byKind).toEqual({ failed: 1 });
  });

  it("heartbeatが止まった実行中ジョブは停滞として数える", () => {
    const summary = buildDevelopmentSummary(
      input({
        issues: [issue({ number: 1 })],
        jobs: [job({ id: "j1", status: "RUNNING", startedAt: "2026-10-05T02:00:00.000Z", finishedAt: null })],
        jobHeartbeats: { j1: "2026-10-05T02:30:00.000Z" },
      }),
    );

    expect(summary.totals.problems.byKind).toEqual({ stalled: 1 });
  });
});

describe("PR", () => {
  const pr = (overrides: Partial<PullRequestSummary>): PullRequestSummary =>
    ({
      id: "o/a#10",
      repositoryFullName: "o/a",
      number: 10,
      title: "PR",
      htmlUrl: "https://github.com/o/a/pull/10",
      draft: false,
      state: "open",
      merged: false,
      mergedAt: null,
      baseRef: "develop",
      headRef: "issue-1",
      linkedIssueNumber: 1,
      linkedIssueNumbers: [1],
      linkedIssueCheckUser: false,
      linkedIssueCheckReason: null,
      autoMergeEnabled: false,
      ciState: "success",
      mergeable: true,
      mergeJudgement: "none",
      reviewVerdict: null,
      ...overrides,
    }) as unknown as PullRequestSummary;

  it("CI失敗・コンフリクト・draft・未取得を区別して数え、取得できなければnull（0にしない）", () => {
    const summary = buildDevelopmentSummary(
      input({
        pullRequests: [
          pr({ id: "o/a#1", number: 1, ciState: "failure" }),
          pr({ id: "o/a#2", number: 2, mergeable: false }),
          pr({ id: "o/a#3", number: 3, draft: true }),
          pr({ id: "o/a#4", number: 4, ciState: "unknown", mergeable: null }),
        ],
      }),
    );

    expect(summary.totals.pullRequests).toMatchObject({ open: 4, draft: 1, ciFailed: 1, conflict: 1, unknown: 1 });
    expect(summary.byRepository["o/b"].pullRequests?.open).toBe(0);

    const missing = buildDevelopmentSummary(input({ pullRequests: null }));
    expect(missing.totals.pullRequests).toBeNull();
    expect(missing.pullRequestsAvailable).toBe(false);
    expect(missing.warnings.length).toBeGreaterThan(0);
  });

  it("対応PRがCI待ちの確認待ちIssueは、エージェント稼働中として別に数える", () => {
    const summary = buildDevelopmentSummary(
      input({
        issues: [issue({ number: 1, labels: [label("00.check-user"), label("01.check-merge")] })],
        pullRequests: [pr({ ciState: "pending" })],
      }),
    );

    expect(summary.totals.checkUser.issues).toBe(0);
    expect(summary.totals.checkUser.excludedRunning).toBe(1);
  });
});

describe("最近の完了", () => {
  const closed = (number: number, closedAt: string, extra: Partial<Issue> = {}) =>
    issue({ number, state: "closed", closedAt, ...extra });

  it("期間は半開区間で、main到達とただのcloseを区別する", () => {
    const summary = buildDevelopmentSummary(
      input({
        issues: [
          closed(1, "2026-09-28T00:00:00.000Z", { projectStatus: "Done" }),
          closed(2, "2026-10-05T03:00:00.000Z", { projectStatus: "Done" }),
          closed(3, "2026-10-01T00:00:00.000Z", { projectStatus: "Done" }),
          closed(4, "2026-10-01T00:00:00.000Z", { stateReason: "not_planned" }),
          closed(5, "2026-09-27T23:59:59.000Z", { projectStatus: "Done" }),
        ],
      }),
    );

    expect(summary.items.recentCompletions.map((i) => i.number).sort()).toEqual([1, 3, 4]);
    expect(summary.totals.recentCompletions).toMatchObject({
      completedIssues: 3,
      reachedMainIssues: 2,
      closedWithoutMainIssues: 1,
      deploySucceededIssues: null,
    });
  });

  it("デプロイの証拠が無ければunknown、あれば成功・失敗を区別する", () => {
    const issues = [
      closed(1, "2026-10-01T00:00:00.000Z", { projectStatus: "Done" }),
      closed(2, "2026-10-01T00:00:00.000Z", { projectStatus: "Done", repositoryFullName: "o/b" }),
    ];
    const noEvidence = buildDevelopmentSummary(input({ issues }));
    expect(noEvidence.items.recentCompletions.every((i) => i.reasonCode === "deploy-unknown")).toBe(true);

    const withEvidence = buildDevelopmentSummary(
      input({
        issues,
        deployEvidence: [
          { repositoryFullName: "o/a", run: { status: "completed", conclusion: "success", createdAt: "2026-10-01T00:05:00.000Z", htmlUrl: "u" }, error: false },
          { repositoryFullName: "o/b", run: { status: "completed", conclusion: "failure", createdAt: "2026-10-01T00:05:00.000Z", htmlUrl: "u" }, error: false },
        ],
      }),
    );
    const codes = Object.fromEntries(withEvidence.items.recentCompletions.map((i) => [i.number, i.reasonCode]));
    expect(codes).toEqual({ 1: "deploy-succeeded", 2: "deploy-failed" });
    expect(withEvidence.totals.recentCompletions.deploySucceededIssues).toBe(1);
  });

  it("同期済みの最古のcloseより前を含む期間は不完全として返す", () => {
    const summary = buildDevelopmentSummary(
      input({ oldestClosedAtInCache: new Date("2026-10-01T00:00:00.000Z") }),
    );

    expect(summary.recentCompletions.historyComplete).toBe(false);
    expect(summary.recentCompletions.historyNote).toContain("下限");
  });
});
