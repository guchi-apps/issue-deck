import { beforeEach, describe, expect, it, vi } from "vitest";

const { loopFindUnique, loopUpdate, loopUpsert, repositoryFindFirst, fetchPullRequest } = vi.hoisted(() => ({
  loopFindUnique: vi.fn(),
  loopUpdate: vi.fn(),
  loopUpsert: vi.fn(),
  repositoryFindFirst: vi.fn(),
  fetchPullRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    pullRequestAutoRepairLoop: { findUnique: loopFindUnique, update: loopUpdate, upsert: loopUpsert },
    repository: { findFirst: repositoryFindFirst },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn().mockResolvedValue("token") }));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequest }));
vi.mock("@/lib/github/workflow-dispatch", () => ({ dispatchWorkflow: vi.fn() }));
vi.mock("@/lib/github/pull-request-repair-run", () => ({ recordPullRequestRepairRun: vi.fn() }));

import { recordReviewFixHandoffStarted } from "@/lib/github/pull-request-auto-repair-start";

const target = { repositoryFullName: "guchi-apps/issue-deck", pullRequestNumber: 10 };

describe("recordReviewFixHandoffStarted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryFindFirst.mockResolvedValue({ installation: { installationId: 1 } });
    fetchPullRequest.mockResolvedValue({ state: "open", draft: false, head: { sha: "abc" } });
  });

  it("系列が無ければ1回目を消化済みで登録する", async () => {
    loopFindUnique.mockResolvedValue(null);
    expect(await recordReviewFixHandoffStarted(target)).toBe("registered");
    expect(loopUpsert.mock.calls[0][0].create).toMatchObject({ round: 1, currentKind: "review", status: "running", maxRounds: 3 });
  });

  it("待機中の系列では1回に数え、上限を超えない", async () => {
    loopFindUnique.mockResolvedValue({ status: "running", currentKind: null, round: 3, maxRounds: 3 });
    expect(await recordReviewFixHandoffStarted(target)).toBe("counted");
    expect(loopUpdate.mock.calls[0][0].data).toMatchObject({ round: 3, currentKind: "review", lastFingerprint: "abc:review" });
  });

  it("巡回が起動済み・停止済み・起動中の系列は触らない", async () => {
    for (const row of [
      { status: "running", currentKind: "review", round: 1, maxRounds: 3 },
      { status: "stopped", currentKind: null, round: 3, maxRounds: 3 },
      { status: "dispatching", currentKind: "ci", round: 1, maxRounds: 3 },
    ]) {
      loopFindUnique.mockResolvedValue(row);
      expect(await recordReviewFixHandoffStarted(target)).toBe("skipped");
    }
    expect(loopUpdate).not.toHaveBeenCalled();
    expect(loopUpsert).not.toHaveBeenCalled();
  });

  it("クローズ済みPRは登録しない", async () => {
    loopFindUnique.mockResolvedValue(null);
    fetchPullRequest.mockResolvedValue({ state: "closed", draft: false, head: { sha: "abc" } });
    expect(await recordReviewFixHandoffStarted(target)).toBe("skipped");
  });
});
