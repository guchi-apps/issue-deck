import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repositoryFindFirst: vi.fn(),
  failureUpsert: vi.fn(),
  failureUpdateMany: vi.fn(),
  fetchWorkflowRun: vi.fn(),
  fetchWorkflowRunJobs: vi.fn(),
  fetchWorkflowJobLogs: vi.fn(),
  queryIssuesByProgressStatus: vi.fn(),
  fetchIssueLabelNames: vi.fn(),
  fetchCommentsForIssue: vi.fn(),
  removeIssueLabel: vi.fn(),
  fetchAllPages: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: mocks.repositoryFindFirst },
    releasePreparationFailure: { upsert: mocks.failureUpsert, updateMany: mocks.failureUpdateMany },
  },
}));
vi.mock("@/lib/release-rebuild-history-run", () => ({ observeRebuildSuccessor: vi.fn(async () => 0) }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({
  fetchWorkflowRun: mocks.fetchWorkflowRun,
  fetchWorkflowRunJobs: mocks.fetchWorkflowRunJobs,
  fetchWorkflowJobLogs: mocks.fetchWorkflowJobLogs,
}));
vi.mock("@/lib/github/query-progress", () => ({ queryIssuesByProgressStatus: mocks.queryIssuesByProgressStatus }));
vi.mock("@/lib/github/issues-api", () => ({
  fetchIssueLabelNames: mocks.fetchIssueLabelNames,
  fetchCommentsForIssue: mocks.fetchCommentsForIssue,
  removeIssueLabel: mocks.removeIssueLabel,
}));
vi.mock("@/lib/github/pagination", () => ({ fetchAllPages: mocks.fetchAllPages }));

import { recordReleasePreparationFailure, resolveReleasePreparation } from "@/lib/release-preparation-run";
import { LEGACY_RELEASE_FAILURE_NOTICE_TEXT } from "@/lib/release-preparation";

const RUN = {
  path: ".github/workflows/release-develop-to-main.yml",
  html_url: "https://github.com/o/r/actions/runs/9",
  status: "completed",
  conclusion: "failure",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
  mocks.fetchWorkflowRun.mockResolvedValue(RUN);
  mocks.failureUpsert.mockResolvedValue({ id: "f1" });
  mocks.failureUpdateMany.mockResolvedValue({ count: 1 });
});

describe("recordReleasePreparationFailure", () => {
  it("GitHubから失敗工程とエラー行を取り直して記録する（Issueへは触れない）", async () => {
    mocks.fetchWorkflowRunJobs.mockResolvedValue([
      { id: 5, name: "release / release", conclusion: "failure", steps: [{ name: "バンプ", conclusion: "failure" }] },
    ]);
    mocks.fetchWorkflowJobLogs.mockResolvedValue("x ##[error]版が一致しません\ny ##[error]Process completed with exit code 1.");

    const result = await recordReleasePreparationFailure({ repositoryFullName: "o/r", runId: 9, event: "workflow_dispatch", bumpKind: "minor" });

    expect(result).toEqual({ ok: true, recorded: "f1" });
    const data = mocks.failureUpsert.mock.calls[0][0].create;
    expect(data).toMatchObject({ runId: "9", stepName: "バンプ", errorExcerpt: "版が一致しません", bumpKind: "minor", status: "open" });
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("リリースworkflow以外のrunは記録しない", async () => {
    mocks.fetchWorkflowRun.mockResolvedValue({ ...RUN, path: ".github/workflows/ci.yml" });
    expect(await recordReleasePreparationFailure({ repositoryFullName: "o/r", runId: 9, event: null, bumpKind: null })).toEqual({
      ok: false,
      reason: "not_release_run",
    });
    expect(mocks.failureUpsert).not.toHaveBeenCalled();
  });
});

describe("resolveReleasePreparation", () => {
  it("失敗由来と確認できたIssueのラベルだけを外し、記録を解決にする", async () => {
    mocks.fetchWorkflowRunJobs.mockResolvedValue([{ name: "release / release", conclusion: "success" }]);
    mocks.queryIssuesByProgressStatus.mockResolvedValue({ available: true, issues: [1, 2, 3] });
    mocks.fetchIssueLabelNames.mockImplementation(async (_o: string, _r: string, n: number) =>
      n === 1 ? ["00.check-user", "01.check-blocked"] : n === 2 ? ["00.check-user", "01.check-input"] : ["30.bug"],
    );
    const notice = {
      body: `${LEGACY_RELEASE_FAILURE_NOTICE_TEXT}\n<!-- issue-deck-fallback-notice -->`,
      user: { login: "github-actions[bot]" },
      created_at: "2026-10-10T15:48:00Z",
    };
    mocks.fetchCommentsForIssue.mockResolvedValue([notice]);
    mocks.fetchAllPages.mockResolvedValue([
      { event: "labeled", label: { name: "00.check-user" }, actor: { login: "github-actions[bot]" }, created_at: "2026-10-10T15:48:02Z" },
      { event: "labeled", label: { name: "01.check-blocked" }, actor: { login: "github-actions[bot]" }, created_at: "2026-10-10T15:48:02Z" },
    ]);

    const result = await resolveReleasePreparation({ repositoryFullName: "o/r", runId: 10 });

    expect(result).toEqual({ ok: true, resolved: 1, clearedIssues: [1] });
    expect(mocks.removeIssueLabel.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      [1, "00.check-user"],
      [1, "01.check-blocked"],
    ]);
  });

  it("releaseジョブが成功していなければ何もしない", async () => {
    mocks.fetchWorkflowRunJobs.mockResolvedValue([{ name: "release / release", conclusion: "failure" }]);
    expect(await resolveReleasePreparation({ repositoryFullName: "o/r", runId: 10 })).toEqual({ ok: false, reason: "run_not_concluded" });
    expect(mocks.failureUpdateMany).not.toHaveBeenCalled();
  });
});
