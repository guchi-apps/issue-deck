import { describe, expect, it } from "vitest";

import { bulkDispatchableIssues, resolveBulkDispatchHost } from "@/lib/dispatch/bulk-dispatch";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue } from "@/types/issue";

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-19T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(overrides.number ?? 1),
    number: 1,
    title: "まとめて実行できるようにする",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: "Ready",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    kind: "LAUNCH",
    status: "QUEUED",
    hostName: "subpc",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    message: null,
    instruction: null,
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    ...overrides,
  } as DispatchJobView;
}

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-19T00:00:00Z",
    lastReportedAt: "2026-08-19T00:00:00Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    ...overrides,
  } as DispatchSessionView;
}

const EMPTY = { hosts: [], jobs: [], sessions: [] };

describe("resolveBulkDispatchHost（#1993）", () => {
  it("積める起動先を返す", () => {
    expect(resolveBulkDispatchHost(issue(), { ...EMPTY, hosts: [host()] })).toBe("subpc");
  });

  it("closeしたIssueは積めない", () => {
    expect(
      resolveBulkDispatchHost(issue({ state: "closed" }), { ...EMPTY, hosts: [host()] }),
    ).toBeNull();
  });

  // 判定材料は「実装を開始」ダイアログと同じ（未完了ジョブ・生きているセッション）
  it("未完了のジョブが積んであれば積めない", () => {
    expect(
      resolveBulkDispatchHost(issue(), { ...EMPTY, hosts: [host()], jobs: [job()] }),
    ).toBeNull();
  });

  it("セッションが生きていれば積めない（#1311）", () => {
    expect(
      resolveBulkDispatchHost(issue(), { ...EMPTY, hosts: [host()], sessions: [session()] }),
    ).toBeNull();
  });

  it("そのリポジトリを実行できないホストしか無ければ積めない", () => {
    expect(
      resolveBulkDispatchHost(issue(), {
        ...EMPTY,
        hosts: [host({ repositories: ["guchi-apps/dayspan"] })],
      }),
    ).toBeNull();
  });

  // #2032。Actionsで走っているIssueはジョブにもセッションにも現れないため、これが無いと素通りする
  it("GitHub Actionsで走っているIssueは積めない（#2032）", () => {
    expect(
      resolveBulkDispatchHost(issue({ number: 7 }), {
        ...EMPTY,
        hosts: [host()],
        actionsRunningIssueIds: new Set(["7"]),
      }),
    ).toBeNull();
  });

  it("Actionsで走っていない他のIssueは従来どおり積める", () => {
    expect(
      resolveBulkDispatchHost(issue({ number: 8 }), {
        ...EMPTY,
        hosts: [host()],
        actionsRunningIssueIds: new Set(["7"]),
      }),
    ).toBe("subpc");
  });
});

describe("bulkDispatchableIssues（#1993）", () => {
  it("積めるIssueだけを返す", () => {
    const issues = [
      issue({ number: 1 }),
      issue({ number: 2, state: "closed" }),
      issue({ number: 3 }),
    ];

    const dispatchable = bulkDispatchableIssues(issues, { ...EMPTY, hosts: [host()] });

    expect(dispatchable.map((target) => target.number)).toEqual([1, 3]);
  });

  it("起動先の申告が1件も無ければ空", () => {
    expect(bulkDispatchableIssues([issue()], EMPTY)).toEqual([]);
  });

  // 入口のバーに出る件数から、押しても積めないぶんを外す（#2032）
  it("GitHub Actionsで走っているIssueは数えない（#2032）", () => {
    const issues = [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })];

    const dispatchable = bulkDispatchableIssues(issues, {
      ...EMPTY,
      hosts: [host()],
      actionsRunningIssueIds: new Set(["2"]),
    });

    expect(dispatchable.map((target) => target.number)).toEqual([1, 3]);
  });
});
