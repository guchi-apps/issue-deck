import { beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";

/**
 * バックアップCI合格後のマージ（#4114）のサービス層。DB・GitHub・PRレビューのジョブは境界でスタブし、
 * 「レビューを積む → 結果を読む → expectedHeadSha付きでマージ／止めて人へ渡す」の流れを確かめる。
 */

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

type Run = Record<string, unknown> & { id: string };
let run: Run;
let gate: Record<string, unknown> | null;
let pr: Record<string, unknown>;
let reviewGate: Record<string, unknown>;
let labels: string[];

const mocks = vi.hoisted(() => ({
  requestPrReviewJob: vi.fn(),
  mergePullRequest: vi.fn(),
  createComment: vi.fn(async () => ({})),
  addCheckUserWithReason: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  db: {
    ciGateState: { findUnique: async () => gate },
    backupCiRun: {
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(run, data),
      findMany: async () => [run],
    },
  },
}));
vi.mock("@/lib/backup-ci/github", () => ({
  installationTokenFor: async () => "token",
  fetchPullRequestMergeInfo: async () => pr,
  pullRequestTouchesPath: async () => false,
}));
vi.mock("@/lib/dispatch/pr-review-jobs", () => ({
  getPrReviewGate: async () => ({ job: null, gate: reviewGate }),
  requestPrReviewJob: mocks.requestPrReviewJob,
}));
vi.mock("@/lib/github/actions-api", () => ({ mergePullRequest: mocks.mergePullRequest }));
vi.mock("@/lib/github/issues-api", () => ({
  createComment: mocks.createComment,
  fetchIssueLabelNames: async () => labels,
}));
vi.mock("@/lib/dispatch/check-user-labels", () => ({ addCheckUserWithReason: mocks.addCheckUserWithReason }));

const { advanceBackupCiMerge } = await import("@/lib/backup-ci/merge-service");

beforeEach(() => {
  vi.clearAllMocks();
  run = {
    id: "run1",
    repositoryFullName: "o/r",
    prNumber: 7,
    headRef: "issue-12",
    status: "passed",
    headSha: HEAD,
    baseSha: BASE,
    mergeStatus: null,
    mergeAttempts: 0,
  };
  gate = { source: "backup", sourceRef: "run1", state: "success", headSha: HEAD, baseSha: BASE };
  pr = {
    state: "open",
    merged: false,
    draft: false,
    headSha: HEAD,
    baseSha: BASE,
    headRef: "issue-12",
    baseRef: "develop",
    mergeable: true,
    mergeableState: "clean",
  };
  reviewGate = { state: "missing" };
  labels = [];
});

describe("advanceBackupCiMerge", () => {
  it("レビューが無ければCodexの`PR_REVIEW`をActionsのrun無しで積み、レビュー待ちにする", async () => {
    mocks.requestPrReviewJob.mockResolvedValue({ ok: true, job: { id: "job1" }, created: true, gate: {} });
    expect(await advanceBackupCiMerge(run as never)).toBe("request_review");
    expect(mocks.requestPrReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { repositoryFullName: "o/r", prNumber: 7, headSha: HEAD, agent: "codex" },
        baseSha: BASE,
        workflowRunId: null,
      }),
    );
    expect(run).toMatchObject({ mergeStatus: "reviewing", reviewJobId: "job1" });
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it("LGTMならexpectedHeadSha付きでマージし、PRへ記録を残す", async () => {
    run.mergeStatus = "reviewing";
    reviewGate = { state: "done", verdict: "lgtm" };
    mocks.mergePullRequest.mockResolvedValue({ sha: "c".repeat(40) });
    expect(await advanceBackupCiMerge(run as never)).toBe("merged");
    expect(mocks.mergePullRequest).toHaveBeenCalledWith("o", "r", 7, "token", HEAD);
    expect(run).toMatchObject({ mergeStatus: "merged", mergeCommitSha: "c".repeat(40) });
    expect(mocks.createComment).toHaveBeenCalledWith("o", "r", 7, "token", expect.anything());
  });

  it("要修正なら00.check-user＋01.check-mergeを付け、Issueへ理由を残してマージしない", async () => {
    run.mergeStatus = "reviewing";
    reviewGate = { state: "done", verdict: "changes-requested" };
    expect(await advanceBackupCiMerge(run as never)).toBe("hold");
    expect(mocks.addCheckUserWithReason).toHaveBeenCalledWith("o", "r", 12, "token", "merge");
    expect(mocks.createComment).toHaveBeenCalledWith("o", "r", 12, "token", expect.anything());
    expect(run.mergeStatus).toBe("held");
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it("サブPCが無くて積めなければ、止まっている（01.check-blocked）として人へ渡す", async () => {
    mocks.requestPrReviewJob.mockResolvedValue({ ok: false, rejection: "no_host", message: "サブPCがありません" });
    expect(await advanceBackupCiMerge(run as never)).toBe("hold");
    expect(mocks.addCheckUserWithReason).toHaveBeenCalledWith("o", "r", 12, "token", "blocked");
  });

  it("head/baseが動いていれば何もしない", async () => {
    pr.headSha = "d".repeat(40);
    expect(await advanceBackupCiMerge(run as never)).toBe("ignore");
    expect(mocks.requestPrReviewJob).not.toHaveBeenCalled();
  });

  it("409（その間のpush）は数えず、それ以外の失敗は上限で諦めて人へ渡す", async () => {
    run.mergeStatus = "reviewing";
    reviewGate = { state: "done", verdict: "lgtm" };
    mocks.mergePullRequest.mockRejectedValue(new GithubApiError(409, "conflict"));
    expect(await advanceBackupCiMerge(run as never)).toBe("wait");
    expect(run.mergeAttempts).toBe(0);

    mocks.mergePullRequest.mockRejectedValue(new GithubApiError(405, "required status check"));
    run.mergeAttempts = 9;
    expect(await advanceBackupCiMerge(run as never)).toBe("merge_failed");
    expect(run).toMatchObject({ mergeStatus: "gave_up", mergeAttempts: 10 });
    expect(mocks.addCheckUserWithReason).toHaveBeenCalledWith("o", "r", 12, "token", "blocked");
  });
});
