import { describe, expect, it, vi } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { enqueueIssueToDefaultHost, type EnqueueIssueDeps } from "@/lib/dispatch/enqueue-issue";
import type { Issue } from "@/types/issue";

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-17T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    planReviewCapable: null,
    selfUpdateCapable: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    checkout: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 42,
    title: "一覧の絞り込みを共通化する",
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
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: "Ready",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/42",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function deps(overrides: Partial<EnqueueIssueDeps> = {}): EnqueueIssueDeps {
  return {
    hosts: [host()],
    sessions: [],
    enqueue: vi.fn().mockResolvedValue(true),
    enqueueError: null,
    updateIssue: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("enqueueIssueToDefaultHost", () => {
  it("積める起動先へ積み、11.localを付ける", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const updateIssue = vi.fn().mockResolvedValue(null);

    const outcome = await enqueueIssueToDefaultHost(issue(), deps({ enqueue, updateIssue }));

    expect(outcome).toEqual({ ok: true, hostName: "subpc" });
    expect(enqueue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 42,
      hostName: "subpc",
    });
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      labels: ["11.local"],
    });
  });

  // まとめて実行（#1993）で選んだオプションは、`11.local`と同じ1回の書き込みで付ける
  it("渡したラベルを11.localと一緒に付ける", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);

    await enqueueIssueToDefaultHost(issue(), deps({ updateIssue }), [
      "21.plan-required",
      "23.preview-required",
    ]);

    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      labels: ["21.plan-required", "23.preview-required", "11.local"],
    });
  });

  it("既に11.localが付いていても、渡したラベルは付ける", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);
    const labels = [{ name: "11.local", color: "ededed", description: null }];

    await enqueueIssueToDefaultHost(issue({ labels }), deps({ updateIssue }), [
      "21.plan-required",
    ]);

    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      labels: ["11.local", "21.plan-required"],
    });
  });

  // 積めていないのにオプションだけ残ると、次に開いたときに押した覚えのないチェックが入る
  it("積み込みが拒否されたら、渡したラベルも付けない", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);

    await enqueueIssueToDefaultHost(
      issue(),
      deps({ enqueue: vi.fn().mockResolvedValue(false), updateIssue }),
      ["21.plan-required"],
    );

    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("既に11.localが付いているIssueにはラベルを付け直さない", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);
    const labels = [{ name: "11.local", color: "ededed", description: null }];

    await enqueueIssueToDefaultHost(issue({ labels }), deps({ updateIssue }));

    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("積める起動先が無ければ積まない", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    const outcome = await enqueueIssueToDefaultHost(issue(), deps({ hosts: [], enqueue }));

    expect(outcome.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("そのリポジトリを実行できないホストしか無ければ、理由を返して積まない", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    const outcome = await enqueueIssueToDefaultHost(
      issue(),
      deps({ hosts: [host({ repositories: ["guchi-apps/dayspan"] })], enqueue }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("実行できません");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("同じIssueのセッションが生きていれば積まない（#1311）", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const sessions = [
      {
        host: "subpc",
        tmuxSessionName: "issue-deck-issue-42",
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 42,
        issueTitle: null,
        issueId: null,
        state: "ALIVE" as const,
        exitStatus: null,
        firstSeenAt: "2026-08-17T00:00:00Z",
        lastReportedAt: "2026-08-17T00:00:00Z",
        activity: null,
        activityAt: null,
        remoteControlUrl: null,
        previewUrl: null,
        reapAt: null,
        reapReason: null,
      },
    ];

    const outcome = await enqueueIssueToDefaultHost(issue(), deps({ sessions, enqueue }));

    expect(outcome.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // **積めなかったIssueに11.localを付けると、無人実行までそのIssueに触れなくなる**
  it("積み込みが拒否されたらラベルを付けない", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);
    const outcome = await enqueueIssueToDefaultHost(
      issue(),
      deps({
        enqueue: vi.fn().mockResolvedValue(false),
        enqueueError: "同時実行数の上限です",
        updateIssue,
      }),
    );

    expect(outcome).toEqual({ ok: false, reason: "同時実行数の上限です" });
    expect(updateIssue).not.toHaveBeenCalled();
  });
});
