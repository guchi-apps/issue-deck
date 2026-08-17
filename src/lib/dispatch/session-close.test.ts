import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchSessionFindMany = vi.fn();
const dispatchJobUpdateMany = vi.fn();
const enqueueSessionControlJob = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchSession: {
      get findMany() {
        return dispatchSessionFindMany;
      },
    },
    dispatchJob: {
      get updateMany() {
        return dispatchJobUpdateMany;
      },
    },
  },
}));

vi.mock("@/lib/dispatch/jobs", () => ({
  get enqueueSessionControlJob() {
    return enqueueSessionControlJob;
  },
}));

import { handleIssueClosedForDispatch, ISSUE_CLOSED_CANCEL_MESSAGE } from "@/lib/dispatch/session-close";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const ISSUE = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 1518, now: NOW };

describe("handleIssueClosedForDispatch", () => {
  beforeEach(() => {
    dispatchSessionFindMany.mockReset().mockResolvedValue([]);
    dispatchJobUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    enqueueSessionControlJob.mockReset().mockResolvedValue({ ok: true, job: { id: "job-1" } });
  });

  it("生きているセッションがあるホストへKILLを積む", async () => {
    dispatchSessionFindMany.mockResolvedValue([{ host: "subpc" }]);

    const result = await handleIssueClosedForDispatch(ISSUE);

    expect(enqueueSessionControlJob).toHaveBeenCalledTimes(1);
    expect(enqueueSessionControlJob).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1518,
      hostName: "subpc",
      kind: "KILL",
      requestedByUserId: null,
      now: NOW,
    });
    expect(result.killedHosts).toEqual(["subpc"]);
  });

  // 終了したペイン（EXITED/FAILED）は最後の出力を読むために残す既存方針に合わせる。
  // ここでは`ALIVE`だけを引いていることを、where条件で確かめる
  it("ALIVEのセッションだけを対象にする", async () => {
    await handleIssueClosedForDispatch(ISSUE);

    expect(dispatchSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryFullName: "guchi-apps/issue-deck",
          issueNumber: 1518,
          state: "ALIVE",
        },
      }),
    );
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("同じホストに複数のセッション行があってもKILLは1回だけ積む", async () => {
    dispatchSessionFindMany.mockResolvedValue([{ host: "subpc" }, { host: "subpc" }]);

    await handleIssueClosedForDispatch(ISSUE);

    expect(enqueueSessionControlJob).toHaveBeenCalledTimes(1);
  });

  it("ホストが複数あればそれぞれへ積む", async () => {
    dispatchSessionFindMany.mockResolvedValue([{ host: "subpc" }, { host: "mainpc" }]);

    const result = await handleIssueClosedForDispatch(ISSUE);

    expect(enqueueSessionControlJob).toHaveBeenCalledTimes(2);
    expect(result.killedHosts).toEqual(["subpc", "mainpc"]);
  });

  it("積めなかった理由は握って返す（closeを失敗させない）", async () => {
    dispatchSessionFindMany.mockResolvedValue([{ host: "subpc" }]);
    enqueueSessionControlJob.mockResolvedValue({
      ok: false,
      rejection: "host_offline",
      message: "応答していません",
    });

    const result = await handleIssueClosedForDispatch(ISSUE);

    expect(result.killedHosts).toEqual([]);
    expect(result.skipped).toEqual([{ host: "subpc", rejection: "host_offline" }]);
  });

  it("KILLの積み込みが例外で落ちても投げず、順番待ちの取り消しは続ける", async () => {
    dispatchSessionFindMany.mockRejectedValue(new Error("db down"));
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleIssueClosedForDispatch(ISSUE);

    expect(result.skipped).toEqual([{ host: "-", rejection: "error" }]);
    expect(result.canceledJobs).toBe(1);
    error.mockRestore();
  });

  it("順番待ち（QUEUED）の起動ジョブを取り消す。CLAIMED以降は触らない", async () => {
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });

    const result = await handleIssueClosedForDispatch(ISSUE);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith({
      where: {
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1518,
        kind: { in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW"] },
        status: "QUEUED",
      },
      data: {
        status: "CANCELED",
        activeKey: null,
        finishedAt: NOW,
        message: ISSUE_CLOSED_CANCEL_MESSAGE,
      },
    });
    expect(result.canceledJobs).toBe(1);
  });
});
