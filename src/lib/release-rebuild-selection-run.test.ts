import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  dispatchReleaseWorkflow: vi.fn(),
  fetchPullRequestForRebuild: vi.fn(),
  isAncestorCommit: vi.fn(),
  releaseCallerSupportsSelection: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    releaseRebuildRequest: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    releaseFixSeries: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/github/release-api", () => ({
  dispatchReleaseWorkflow: mocks.dispatchReleaseWorkflow,
  fetchPullRequestForRebuild: mocks.fetchPullRequestForRebuild,
  fetchRefCiState: vi.fn(async () => "success"),
  fetchReleaseRebuildCandidate: vi.fn(),
  isAncestorCommit: mocks.isAncestorCommit,
  releaseCallerSupportsSelection: mocks.releaseCallerSupportsSelection,
}));

import { requestSelectiveRebuild } from "@/lib/release-rebuild-selection-run";

const ORIGIN = "c".repeat(40);
const releasePr = { number: 99, html_url: "u", title: "v8.50.1", body: null, head: { ref: "release-main/v8.50.1", sha: ORIGIN } };

function pr(number: number, mergeSha: string | null, mergedAt: string | null) {
  return {
    number,
    title: `PR${number}`,
    html_url: `https://github.com/o/r/pull/${number}`,
    state: mergedAt ? "closed" : "open",
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    base: { ref: "develop" },
    head: { ref: `issue-${number}`, sha: "f".repeat(40) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.releaseCallerSupportsSelection.mockResolvedValue(true);
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: "req1" });
  mocks.isAncestorCommit.mockResolvedValue(false);
});

const call = (selected: { number: number; expectedMergeSha?: string | null }[]) =>
  requestSelectiveRebuild({ owner: "o", repo: "r", token: "t", releasePr, selected, source: "manual", userId: "u1" });

describe("requestSelectiveRebuild", () => {
  it("選んだPRだけを、developへ入った順に、マージコミット付きでworkflowへ渡す（元の候補は閉じない）", async () => {
    const A = "a".repeat(40);
    const C = "e".repeat(40);
    mocks.fetchPullRequestForRebuild.mockImplementation(async (_o: string, _r: string, n: number) =>
      n === 22 ? pr(22, C, "2026-10-10T12:00:00Z") : pr(20, A, "2026-10-10T10:00:00Z"),
    );

    const result = await call([{ number: 22 }, { number: 20 }]);

    expect(result).toMatchObject({ ok: true, requestId: "req1" });
    const selection = JSON.parse(mocks.dispatchReleaseWorkflow.mock.calls[0][5]);
    expect(selection).toEqual({ origin: { pr: 99, headSha: ORIGIN }, prs: [{ number: 20, mergeSha: A }, { number: 22, mergeSha: C }] });
    expect(mocks.create.mock.calls[0][0].data.activeKey).toBe(`o/r#99@${ORIGIN}`);
  });

  it("未マージ・取り込み済みのPRがあれば理由を返して起動しない（選択を広げない・省かない）", async () => {
    mocks.fetchPullRequestForRebuild.mockImplementation(async (_o: string, _r: string, n: number) =>
      n === 30 ? pr(30, null, null) : pr(20, "a".repeat(40), "2026-10-10T10:00:00Z"),
    );
    mocks.isAncestorCommit.mockResolvedValue(true);

    const result = await call([{ number: 20 }, { number: 30 }]);

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_selection",
      problems: [
        { number: 20, problem: "already_included" },
        { number: 30, problem: "not_merged" },
      ],
    });
    expect(mocks.dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it("同じ元の候補への作り直しが進行中なら二重に起動しない", async () => {
    mocks.fetchPullRequestForRebuild.mockResolvedValue(pr(20, "a".repeat(40), "2026-10-10T10:00:00Z"));
    mocks.findUnique.mockResolvedValue({ id: "old", status: "dispatched", createdAt: new Date(), activeKey: "k" });

    expect(await call([{ number: 20 }])).toEqual({ ok: false, error: "rebuild_in_progress" });
    expect(mocks.dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it("選んだ作り直しに対応していないcallerには送らない", async () => {
    mocks.releaseCallerSupportsSelection.mockResolvedValue(false);
    expect(await call([{ number: 20 }])).toEqual({ ok: false, error: "selection_unsupported" });
  });

  it("起動に失敗したら依頼を失敗にして、やり直せるようにする", async () => {
    mocks.fetchPullRequestForRebuild.mockResolvedValue(pr(20, "a".repeat(40), "2026-10-10T10:00:00Z"));
    mocks.dispatchReleaseWorkflow.mockRejectedValue(new Error("422"));

    expect(await call([{ number: 20 }])).toEqual({ ok: false, error: "dispatch_failed" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", activeKey: null }) }));
  });
});
