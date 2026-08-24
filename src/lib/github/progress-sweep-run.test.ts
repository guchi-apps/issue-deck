import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFindMany = vi.fn();
const issueFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectItems = vi.fn();
const fetchPullRequestsForHead = vi.fn();
const fetchBranchHeadSha = vi.fn();
const compareBranches = vi.fn();
const fetchCommentsForIssue = vi.fn();
const createComment = vi.fn();
const removeIssueLabel = vi.fn();
const addIssueLabels = vi.fn();
const fetchRepositoryLabelNames = vi.fn();
const addCheckUserWithReason = vi.fn();
const reportProgressStatus = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
    },
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/projects-api", () => ({
  get fetchProjectItems() {
    return fetchProjectItems;
  },
}));

vi.mock("@/lib/github/pull-requests-api", () => ({
  get fetchPullRequestsForHead() {
    return fetchPullRequestsForHead;
  },
}));

vi.mock("@/lib/github/branches-api", () => ({
  get fetchBranchHeadSha() {
    return fetchBranchHeadSha;
  },
  get compareBranches() {
    return compareBranches;
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get fetchCommentsForIssue() {
    return fetchCommentsForIssue;
  },
  get createComment() {
    return createComment;
  },
  get removeIssueLabel() {
    return removeIssueLabel;
  },
  get addIssueLabels() {
    return addIssueLabels;
  },
  get fetchRepositoryLabelNames() {
    return fetchRepositoryLabelNames;
  },
}));

vi.mock("@/lib/dispatch/check-user-labels", () => ({
  get addCheckUserWithReason() {
    return addCheckUserWithReason;
  },
}));

vi.mock("@/lib/github/report-progress", () => ({
  get reportProgressStatus() {
    return reportProgressStatus;
  },
}));

import { resetProgressSweepIntervalForTest, runProgressSweep } from "./progress-sweep-run";

const NOW = new Date("2026-08-25T12:00:00Z");

const REPO = {
  id: "repo-issue-deck",
  githubRepositoryId: 555,
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  fullName: "guchi-apps/issue-deck",
  installation: { id: "inst-row", installationId: 111 },
};

function projectItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "item-1",
    repositoryDatabaseId: 555,
    issueNumber: 2294,
    issueOpen: true,
    status: "Develop PR",
    ...overrides,
  };
}

function mergedPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    html_url: "https://github.com/guchi-apps/issue-deck/pull/1",
    merged_at: "2026-08-25T10:00:00Z",
    head: { ref: "issue-2294", sha: "aaa111" },
    ...overrides,
  };
}

/** state引数で「クローズ済み」「開いている」を出し分けるモック */
function pullRequestsForHead(closed: unknown[], open: unknown[] = []) {
  return vi.fn(async (..._args: unknown[]) => (_args[4] === "closed" ? closed : open));
}

describe("runProgressSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProgressSweepIntervalForTest();
    delete process.env.PROGRESS_SWEEP_INTERVAL_MINUTES;
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    repositoryFindMany.mockResolvedValue([REPO]);
    issueFindMany.mockResolvedValue([]);
    getInstallationToken.mockResolvedValue("token");
    fetchProjectItems.mockResolvedValue([projectItem()]);
    fetchPullRequestsForHead.mockImplementation(pullRequestsForHead([mergedPullRequest()]));
    fetchBranchHeadSha.mockResolvedValue("aaa111");
    compareBranches.mockResolvedValue(null);
    fetchCommentsForIssue.mockResolvedValue([]);
    createComment.mockResolvedValue({});
    removeIssueLabel.mockResolvedValue([]);
    addIssueLabels.mockResolvedValue([]);
    fetchRepositoryLabelNames.mockResolvedValue(new Set(["71.manual-step"]));
    addCheckUserWithReason.mockResolvedValue([]);
    reportProgressStatus.mockResolvedValue({ applied: true, from: "Develop PR", to: "Develop" });
  });

  afterEach(() => {
    delete process.env.PROJECT_V2_OWNER;
    delete process.env.PROJECT_V2_NUMBER;
    delete process.env.PROGRESS_SWEEP_INTERVAL_MINUTES;
  });

  it("マージ済みなのに取り残されたIssueをDevelopへ進め、確認待ちを解いて通知する", async () => {
    const result = await runProgressSweep({ now: NOW });

    expect(result.swept).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.actions).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 2294, kind: "advanced" },
    ]);
    expect(reportProgressStatus).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2294,
      status: "develop",
      onlyFrom: ["develop-pr", "implementation"],
    });
    // `00.check-user`を外す
    expect(removeIssueLabel).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      2294,
      "token",
      "00.check-user",
    );
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][4].body).toContain("developへのマージが完了しました");
  });

  it("同じPRのマージを通知済みならコメントを重ねない（進捗の報告は続ける）", async () => {
    fetchCommentsForIssue.mockResolvedValue([
      {
        body: "✅ developへのマージが完了しました: https://github.com/guchi-apps/issue-deck/pull/1",
      },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.actions).toHaveLength(1);
    expect(reportProgressStatus).toHaveBeenCalled();
  });

  it("マージ済みPRが無ければ何もしない", async () => {
    fetchPullRequestsForHead.mockImplementation(pullRequestsForHead([]));

    const result = await runProgressSweep({ now: NOW });

    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ no_merged_pr: 1 });
    expect(reportProgressStatus).not.toHaveBeenCalled();
  });

  it("developへ入らないコミットが残っていれば取り残しとして通知し、進捗は進めない", async () => {
    fetchBranchHeadSha.mockResolvedValue("bbb222");
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      changedFiles: 3,
      lastCommitAt: new Date(NOW.getTime() - 300 * 60_000).toISOString(),
    });

    const result = await runProgressSweep({ now: NOW });

    expect(result.actions).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 2294, kind: "stranded" },
    ]);
    expect(addCheckUserWithReason).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      2294,
      "token",
      "blocked",
    );
    expect(createComment.mock.calls[0][4].body).toContain("developへ入っていないコミット");
    expect(reportProgressStatus).not.toHaveBeenCalled();
  });

  it("開いているdevelop向けPRがあれば実装中とみなして見送る", async () => {
    fetchBranchHeadSha.mockResolvedValue("bbb222");
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      changedFiles: 3,
      lastCommitAt: new Date(NOW.getTime() - 300 * 60_000).toISOString(),
    });
    fetchPullRequestsForHead.mockImplementation(
      pullRequestsForHead([mergedPullRequest()], [{ html_url: "https://example.invalid/2" }]),
    );

    const result = await runProgressSweep({ now: NOW });

    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ develop_pr_open: 1 });
    expect(addCheckUserWithReason).not.toHaveBeenCalled();
  });

  it("1件が落ちても巡回全体は止めない", async () => {
    fetchBranchHeadSha.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runProgressSweep({ now: NOW });

    expect(result.swept).toBe(true);
    expect(result.skipped).toMatchObject({ fetch_failed: 1 });
    error.mockRestore();
  });

  it("間隔に達していなければ巡回しない（forceで無視できる）", async () => {
    await runProgressSweep({ now: NOW });
    const second = await runProgressSweep({ now: new Date(NOW.getTime() + 60_000) });

    expect(second.swept).toBe(false);
    expect(fetchProjectItems).toHaveBeenCalledTimes(1);

    const forced = await runProgressSweep({ now: new Date(NOW.getTime() + 60_000), force: true });
    expect(forced.swept).toBe(true);
  });

  it("PROGRESS_SWEEP_INTERVAL_MINUTES=0 で止められる", async () => {
    process.env.PROGRESS_SWEEP_INTERVAL_MINUTES = "0";

    const result = await runProgressSweep({ now: NOW });

    expect(result).toMatchObject({ swept: false, disabled: true });
    expect(fetchProjectItems).not.toHaveBeenCalled();
  });

  it("ラベルの無い手作業Issueへ 71.manual-step を付け直す", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockResolvedValue([
      {
        number: 40,
        title: "[手作業] VPS: .envを更新する",
        repository: {
          ownerLogin: "guchi-apps",
          name: "vps",
          fullName: "guchi-apps/vps",
          installation: { id: "inst-row", installationId: 111 },
        },
      },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(addIssueLabels).toHaveBeenCalledWith("guchi-apps", "vps", 40, "token", [
      "71.manual-step",
    ]);
    expect(result.actions).toEqual([
      { repositoryFullName: "guchi-apps/vps", issueNumber: 40, kind: "manual_step_labeled" },
    ]);
  });

  it("ラベル定義が無いリポジトリへは付けない（色も説明も無いラベルを生やさない）", async () => {
    fetchProjectItems.mockResolvedValue([]);
    fetchRepositoryLabelNames.mockResolvedValue(new Set(["00.check-user"]));
    issueFindMany.mockResolvedValue([
      {
        number: 40,
        title: "[手作業] VPS: .envを更新する",
        repository: {
          ownerLogin: "guchi-apps",
          name: "vps",
          fullName: "guchi-apps/vps",
          installation: { id: "inst-row", installationId: 111 },
        },
      },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(addIssueLabels).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it("Project連携が無効でも手作業ラベルの埋め直しは行う", async () => {
    delete process.env.PROJECT_V2_OWNER;
    issueFindMany.mockResolvedValue([
      {
        number: 40,
        title: "[手作業] VPS: .envを更新する",
        repository: {
          ownerLogin: "guchi-apps",
          name: "vps",
          fullName: "guchi-apps/vps",
          installation: { id: "inst-row", installationId: 111 },
        },
      },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(fetchProjectItems).not.toHaveBeenCalled();
    expect(result.candidates).toBe(0);
    expect(result.actions).toHaveLength(1);
  });
});
