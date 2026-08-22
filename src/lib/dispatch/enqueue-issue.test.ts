import { describe, expect, it, vi } from "vitest";

import {
  ACTIONS_RUNNING_ENQUEUE_REASON,
  type DispatchHostView,
} from "@/lib/dispatch/dispatch-job";
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
    codeReviewCapable: null,
    selfUpdateCapable: null,
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
    manualStepVerifiedAt: null,
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

  // まとめて実行（#1993）で選んだオプションは、**積むより先に**付ける。ランチャーは起動直後に
  // ラベルを読むため（`scripts/start-issue.sh`）、積んだ後に付けると読まれないことがある
  it("渡したラベルは積む前に付け、11.localは積んだ後に付ける", async () => {
    const order: string[] = [];
    const updateIssue = vi.fn().mockImplementation((input: { labels: string[] }) => {
      order.push(`update:${input.labels.join(",")}`);
      return Promise.resolve(null);
    });
    const enqueue = vi.fn().mockImplementation(() => {
      order.push("enqueue");
      return Promise.resolve(true);
    });

    await enqueueIssueToDefaultHost(issue(), deps({ enqueue, updateIssue }), [
      "21.plan-required",
      "23.preview-required",
    ]);

    expect(order).toEqual([
      "update:21.plan-required,23.preview-required",
      "enqueue",
      "update:21.plan-required,23.preview-required,11.local",
    ]);
  });

  it("既に11.localが付いていても、渡したラベルは付ける", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);
    const labels = [{ name: "11.local", color: "ededed", description: null }];

    await enqueueIssueToDefaultHost(issue({ labels }), deps({ updateIssue }), [
      "21.plan-required",
    ]);

    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      labels: ["11.local", "21.plan-required"],
    });
  });

  // 押す前の判定を通ってから書くので、ここまで来るのはAPI側で弾かれた場合だけ
  it("積み込みが拒否されても、11.localは付けない", async () => {
    const updateIssue = vi.fn().mockResolvedValue(null);

    await enqueueIssueToDefaultHost(
      issue(),
      deps({ enqueue: vi.fn().mockResolvedValue(false), updateIssue }),
      ["21.plan-required"],
    );

    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      labels: ["21.plan-required"],
    });
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

  // #2032。Actionsで走っているIssueはジョブにもセッションにも現れないため、これが無いと
  // 「まとめて実行」がそのまま積み、同じブランチを2つの経路が進める
  it("GitHub Actionsで走っているIssueは積まず、ラベルも付けない（#2032）", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const updateIssue = vi.fn().mockResolvedValue(null);

    const outcome = await enqueueIssueToDefaultHost(
      issue({ id: "abc" }),
      deps({ enqueue, updateIssue, actionsRunningIssueIds: new Set(["abc"]) }),
      ["21.plan-required"],
    );

    expect(outcome.ok).toBe(false);
    expect(outcome).toEqual({ ok: false, reason: ACTIONS_RUNNING_ENQUEUE_REASON });
    expect(enqueue).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("Actionsで走っている他のIssueに引きずられない（#2032）", async () => {
    const enqueue = vi.fn().mockResolvedValue(true);

    const outcome = await enqueueIssueToDefaultHost(
      issue({ id: "abc" }),
      deps({ enqueue, actionsRunningIssueIds: new Set(["xyz"]) }),
    );

    expect(outcome).toEqual({ ok: true, hostName: "subpc" });
    expect(enqueue).toHaveBeenCalled();
  });
});
