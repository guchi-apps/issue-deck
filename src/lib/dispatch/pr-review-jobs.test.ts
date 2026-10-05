import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const dispatchHostFindMany = vi.fn();
const dispatchJobFindFirst = vi.fn();
const dispatchJobFindUnique = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchJobCreate = vi.fn();
const dispatchJobUpdate = vi.fn();
const dispatchJobUpdateMany = vi.fn();
const dispatchJobGroupBy = vi.fn();
const repositoryFindFirst = vi.fn();
const fetchPullRequest = vi.fn();
const fetchWorkflowRun = vi.fn();
const fetchWorkflowRunJobs = vi.fn();
const rerunWorkflowJob = vi.fn();
const githubFetch = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: { findMany: dispatchHostFindMany },
    dispatchJob: {
      findFirst: dispatchJobFindFirst,
      findUnique: dispatchJobFindUnique,
      findMany: dispatchJobFindMany,
      create: dispatchJobCreate,
      update: dispatchJobUpdate,
      updateMany: dispatchJobUpdateMany,
      groupBy: dispatchJobGroupBy,
    },
    repository: { findFirst: repositoryFindFirst },
  },
}));
vi.mock("@/lib/dispatch/jobs", () => ({ expireStaleDispatchJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn().mockResolvedValue("token") }));
vi.mock("@/lib/github/request", () => ({ GITHUB_API: "https://api.github.com", githubFetch }));
vi.mock("@/lib/github/actions-api", () => ({
  fetchPullRequest,
  fetchWorkflowRun,
  fetchWorkflowRunJobs,
  rerunWorkflowJob,
}));

const { requestPrReviewJob, resumePrReviewMerge, sweepPrReviewResumes } = await import("./pr-review-jobs");

const NOW = new Date("2026-10-05T12:00:00Z");
const target = { repositoryFullName: "guchi-apps/issue-deck", prNumber: 7, headSha: HEAD, agent: "codex" as const };

function host(overrides = {}) {
  return {
    name: "subpc",
    lastSeenAt: NOW,
    prReviewCapable: true,
    codexCapable: true,
    repositories: JSON.stringify(["guchi-apps/issue-deck"]),
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: "job-1",
    kind: "PR_REVIEW",
    status: "SUCCEEDED",
    repositoryFullName: "guchi-apps/issue-deck",
    prNumber: 7,
    headSha: HEAD,
    workflowRunId: "999",
    reviewVerdict: "lgtm",
    message: null,
    targetHost: "subpc",
    claimedByHost: "subpc",
    mergeResumedAt: null,
    mergeResumeAttempts: 0,
    finishedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchJobFindFirst.mockResolvedValue(null);
  dispatchJobGroupBy.mockResolvedValue([]);
  dispatchJobUpdateMany.mockResolvedValue({ count: 0 });
  dispatchJobUpdate.mockImplementation(async ({ data }) => ({ ...job(), ...data }));
  dispatchJobCreate.mockImplementation(async ({ data }) => ({ id: "new", ...data }));
});

describe("requestPrReviewJob", () => {
  it("実行できるサブPCが無ければ、積まずに理由つきで断る（起動前の失敗を即座に確定する）", async () => {
    dispatchHostFindMany.mockResolvedValue([host({ prReviewCapable: null })]);
    const result = await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "999", now: NOW });
    expect(result).toMatchObject({ ok: false, rejection: "no_host" });
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("対応を申告し、そのリポジトリを持つオンラインのホストへ、専用列つきで積む", async () => {
    dispatchHostFindMany.mockResolvedValue([host()]);
    const result = await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "999", now: NOW });
    expect(result).toMatchObject({ ok: true, created: true });
    expect(dispatchJobCreate.mock.calls[0][0].data).toMatchObject({
      kind: "PR_REVIEW",
      targetHost: "subpc",
      agent: "codex",
      issueNumber: 7,
      prNumber: 7,
      baseSha: BASE,
      headSha: HEAD,
      workflowRunId: "999",
      activeKey: `pr_review:guchi-apps/issue-deck#7@${HEAD}:codex`,
    });
  });

  it("同じPR・HEAD・agentの未完了があれば積み直さない（二重レビューの防止）", async () => {
    dispatchJobFindFirst.mockResolvedValue(job({ status: "RUNNING", workflowRunId: "999" }));
    const result = await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "999", now: NOW });
    expect(result).toMatchObject({ ok: true, created: false });
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("判定済みなら再依頼でも積み直さず、再実行されたrunへ最終判定の再開先だけを付け替える", async () => {
    dispatchJobFindFirst.mockResolvedValue(job({ workflowRunId: "111" }));
    const result = await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "222", now: NOW });
    expect(result).toMatchObject({ ok: true, created: false, gate: { state: "done" } });
    expect(dispatchJobCreate).not.toHaveBeenCalled();
    expect(dispatchJobUpdate.mock.calls[0][0].data).toMatchObject({ workflowRunId: "222", mergeResumedAt: null });
  });

  it("失敗した後の再依頼（手動の再実行）は新しいジョブを積む", async () => {
    dispatchJobFindFirst.mockResolvedValue(job({ status: "FAILED", reviewVerdict: null, message: "x" }));
    dispatchHostFindMany.mockResolvedValue([host()]);
    const result = await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "999", now: NOW });
    expect(result).toMatchObject({ ok: true, created: true });
  });

  it("新しいHEADを積むときは、古いHEADの待機中のジョブを取り消す", async () => {
    dispatchHostFindMany.mockResolvedValue([host()]);
    await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: "999", now: NOW });
    expect(dispatchJobUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { kind: "PR_REVIEW", prNumber: 7, status: "QUEUED", headSha: { not: HEAD } },
      data: { status: "CANCELED", activeKey: null },
    });
  });

  it("実行待ちの少ないホストへ寄せる", async () => {
    dispatchHostFindMany.mockResolvedValue([host({ name: "a" }), host({ name: "b" })]);
    dispatchJobGroupBy.mockResolvedValue([{ targetHost: "a", _count: { _all: 3 } }]);
    await requestPrReviewJob({ target, baseSha: BASE, workflowRunId: null, now: NOW });
    expect(dispatchJobCreate.mock.calls[0][0].data.targetHost).toBe("b");
  });
});

describe("resumePrReviewMerge", () => {
  beforeEach(() => {
    dispatchJobFindUnique.mockResolvedValue(job());
    repositoryFindFirst.mockResolvedValue({ installation: { installationId: 1 } });
    fetchPullRequest.mockResolvedValue({ head: { sha: HEAD } });
    fetchWorkflowRun.mockResolvedValue({ status: "completed" });
    fetchWorkflowRunJobs.mockResolvedValue([
      { id: 1, name: "review / codex-review" },
      { id: 2, name: "review / auto-merge" },
      { id: 3, name: "review / auto-merge-fallback" },
    ]);
    rerunWorkflowJob.mockResolvedValue(undefined);
  });

  it("同じrunの auto-merge ジョブだけを再実行して、再開済みにする", async () => {
    expect(await resumePrReviewMerge("job-1", NOW)).toBe("resumed");
    expect(rerunWorkflowJob).toHaveBeenCalledWith("guchi-apps", "issue-deck", 2, "token");
    expect(dispatchJobUpdate.mock.calls.at(-1)?.[0].data.mergeResumedAt).toEqual(NOW);
  });

  it("PRのHEADが進んでいたら再実行しない（新しいrunの判定を壊さない）", async () => {
    fetchPullRequest.mockResolvedValue({ head: { sha: "c".repeat(40) } });
    expect(await resumePrReviewMerge("job-1", NOW)).toBe("stale");
    expect(rerunWorkflowJob).not.toHaveBeenCalled();
  });

  it("runがまだ実行中なら、再開済みにせず待つ", async () => {
    fetchWorkflowRun.mockResolvedValue({ status: "in_progress" });
    expect(await resumePrReviewMerge("job-1", NOW)).toBe("waiting");
    expect(rerunWorkflowJob).not.toHaveBeenCalled();
    expect(dispatchJobUpdate).not.toHaveBeenCalled();
  });

  it("未完了・取り消し・再開済みのジョブは対象外", async () => {
    for (const overrides of [{ status: "RUNNING" }, { status: "CANCELED" }, { mergeResumedAt: NOW }]) {
      dispatchJobFindUnique.mockResolvedValue(job(overrides));
      expect(await resumePrReviewMerge("job-1", NOW)).toBe("skipped");
    }
    expect(rerunWorkflowJob).not.toHaveBeenCalled();
  });

  it("GitHubの呼び出しが失敗したら試行回数を数えて投げ直し、上限で諦める", async () => {
    rerunWorkflowJob.mockRejectedValue(new Error("boom"));
    await expect(resumePrReviewMerge("job-1", NOW)).rejects.toThrow("boom");
    expect(dispatchJobUpdate.mock.calls[0][0].data).toEqual({ mergeResumeAttempts: 1 });

    dispatchJobFindUnique.mockResolvedValue(job({ mergeResumeAttempts: 9 }));
    expect(await resumePrReviewMerge("job-1", NOW)).toBe("gave_up");
    // 黙って諦めず、PRへ理由を残す
    expect(githubFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/guchi-apps/issue-deck/issues/7/comments",
      "token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("24時間を過ぎた確定済みのジョブは再開を諦める", async () => {
    dispatchJobFindUnique.mockResolvedValue(job({ finishedAt: new Date("2026-10-03T00:00:00Z") }));
    expect(await resumePrReviewMerge("job-1", NOW)).toBe("gave_up");
    expect(rerunWorkflowJob).not.toHaveBeenCalled();
  });

  it("巡回は確定済みで未再開のジョブを順に再開し、失敗は件数に数えて続ける", async () => {
    dispatchJobFindMany.mockResolvedValue([job({ id: "j1" }), job({ id: "j2" })]);
    dispatchJobFindUnique.mockImplementation(async ({ where }) => job({ id: where.id }));
    rerunWorkflowJob.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const counts = await sweepPrReviewResumes(NOW);
    expect(counts).toMatchObject({ failed: 1, resumed: 1 });
  });
});
