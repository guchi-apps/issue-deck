import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFindMany = vi.fn();
const issueFindMany = vi.fn();
const dispatchSessionFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectItems = vi.fn();
const fetchPullRequestsForHead = vi.fn();
const fetchBranchHeadSha = vi.fn();
const compareBranches = vi.fn();
const fetchCommentsForIssue = vi.fn();
const createComment = vi.fn();
const hasReopenedEvent = vi.fn();
const updateIssue = vi.fn();
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
    dispatchSession: {
      get findMany() {
        return dispatchSessionFindMany;
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
  get hasReopenedEvent() {
    return hasReopenedEvent;
  },
  get updateIssue() {
    return updateIssue;
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

/**
 * `db.issue.findMany`は2つの巡回（滞留した`00.check-user`の回収・手作業ラベルの埋め直し）が
 * 使うので、`where`の形で振り分ける。手作業側だけが`title`で絞り込む。
 */
function issueRowsFor(rows: { staleCheckUser?: unknown[]; manualStep?: unknown[] }) {
  return vi.fn(async (args: { where?: { title?: unknown } }) =>
    args?.where?.title === undefined ? (rows.staleCheckUser ?? []) : (rows.manualStep ?? []),
  );
}

/** signaly#200の実測。11:27:25にラベルが付き、11:28:28にPRがマージされた */
const CHECK_USER_LABELED_AT = new Date("2026-08-25T11:27:25Z");
const CHECK_USER_MERGED_AT = "2026-08-25T11:28:28Z";

/** 滞留した`00.check-user`の回収が拾う行 */
function staleCheckUserRow(
  number: number,
  checkUserLabeledAt: Date | null = CHECK_USER_LABELED_AT,
  name = "signaly",
) {
  return {
    number,
    checkUserLabeledAt,
    repository: {
      ownerLogin: "guchi-apps",
      name,
      fullName: `guchi-apps/${name}`,
      installation: { id: "inst-row", installationId: 111 },
    },
  };
}

/** 手作業ラベルの埋め直しが拾う行 */
function manualStepRow(number: number) {
  return {
    number,
    title: "[手作業] VPS: .envを更新する",
    repository: {
      ownerLogin: "guchi-apps",
      name: "vps",
      fullName: "guchi-apps/vps",
      installation: { id: "inst-row", installationId: 111 },
    },
  };
}

describe("runProgressSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProgressSweepIntervalForTest();
    delete process.env.PROGRESS_SWEEP_INTERVAL_MINUTES;
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    repositoryFindMany.mockResolvedValue([REPO]);
    issueFindMany.mockImplementation(issueRowsFor({}));
    dispatchSessionFindMany.mockResolvedValue([]);
    getInstallationToken.mockResolvedValue("token");
    fetchProjectItems.mockResolvedValue([projectItem()]);
    fetchPullRequestsForHead.mockImplementation(pullRequestsForHead([mergedPullRequest()]));
    fetchBranchHeadSha.mockResolvedValue("aaa111");
    compareBranches.mockResolvedValue(null);
    fetchCommentsForIssue.mockResolvedValue([]);
    createComment.mockResolvedValue({});
    hasReopenedEvent.mockResolvedValue(false);
    updateIssue.mockResolvedValue({});
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

  it("同じ先端について通知済みなら重ねて通知しない（配布前のジョブと同じマーカーで見分ける）", async () => {
    fetchBranchHeadSha.mockResolvedValue("bbb222");
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      changedFiles: 3,
      lastCommitAt: new Date(NOW.getTime() - 300 * 60_000).toISOString(),
    });
    fetchCommentsForIssue.mockResolvedValue([
      { body: "⚠️ 既に通知済み\n<!-- issue-deck-stranded:issue-2294@bbb222 -->" },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ already_notified: 1 });
    expect(createComment).not.toHaveBeenCalled();
    expect(addCheckUserWithReason).not.toHaveBeenCalled();
  });

  it("見送るだけの巡回ではコメント一覧を引かない（共有のレート制限枠を使わない）", async () => {
    fetchPullRequestsForHead.mockImplementation(pullRequestsForHead([]));

    await runProgressSweep({ now: NOW });

    expect(fetchCommentsForIssue).not.toHaveBeenCalled();
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

  it("マージ時に外しそこねた 00.check-user を外す（#2335。signaly#200の形）", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ staleCheckUser: [staleCheckUserRow(200)] }));
    fetchPullRequestsForHead.mockResolvedValue([
      { state: "closed", merged_at: CHECK_USER_MERGED_AT },
    ]);
    removeIssueLabel.mockResolvedValue(["01.check-merge", "40.unexpected"]);

    const result = await runProgressSweep({ now: NOW });

    // baseは絞らず、開いているPRも含めて1回で引く
    expect(fetchPullRequestsForHead).toHaveBeenCalledWith(
      "guchi-apps",
      "signaly",
      null,
      "issue-200",
      "all",
      "token",
    );
    expect(removeIssueLabel).toHaveBeenCalledWith(
      "guchi-apps",
      "signaly",
      200,
      "token",
      "00.check-user",
    );
    // 理由ラベルは`01.check-merge`決め打ちではなく、付いているものを外す
    expect(removeIssueLabel).toHaveBeenCalledWith(
      "guchi-apps",
      "signaly",
      200,
      "token",
      "01.check-merge",
    );
    expect(result.actions).toEqual([
      { repositoryFullName: "guchi-apps/signaly", issueNumber: 200, kind: "check_user_cleared" },
    ]);
    // 進捗は動かさない（Developまで進み終えたIssueのラベルだけを相手にする）
    expect(reportProgressStatus).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it("探すのは Develop・Release にいるopenなIssueだけ", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ staleCheckUser: [staleCheckUserRow(200)] }));
    fetchPullRequestsForHead.mockResolvedValue([]);

    await runProgressSweep({ now: NOW });

    const where = issueFindMany.mock.calls.map((call) => call[0]?.where).find((w) => !w?.title);
    expect(where).toMatchObject({
      state: "OPEN",
      labels: { some: { name: "00.check-user" } },
      checkUserLabeledAt: { not: null },
      projectStatus: { in: ["Develop", "Release"] },
    });
  });

  it("マージより後に付いた確認待ちは外さない（判定前にマージされた場合の事後確認。#1968）", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(
      issueRowsFor({ staleCheckUser: [staleCheckUserRow(200, new Date("2026-08-25T11:30:00Z"))] }),
    );
    fetchPullRequestsForHead.mockResolvedValue([
      { state: "closed", merged_at: CHECK_USER_MERGED_AT },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(removeIssueLabel).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ check_user_after_merge: 1 });
  });

  it("まだ開いているPRがあれば外さない（本物のマージ待ち）", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ staleCheckUser: [staleCheckUserRow(200)] }));
    fetchPullRequestsForHead.mockResolvedValue([
      { state: "closed", merged_at: CHECK_USER_MERGED_AT },
      { state: "open", merged_at: null },
    ]);

    const result = await runProgressSweep({ now: NOW });

    expect(removeIssueLabel).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ check_user_pr_open: 1 });
  });

  it("issue-<番号>のマージ済みPRが無ければ外さない（人が手で付けた確認待ちを消さない）", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ staleCheckUser: [staleCheckUserRow(200)] }));
    fetchPullRequestsForHead.mockResolvedValue([]);

    const result = await runProgressSweep({ now: NOW });

    expect(removeIssueLabel).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(result.skipped).toMatchObject({ check_user_no_merged_pr: 1 });
  });

  it("DBが古くて実際には付いていなかった場合、巡回の成果として数えない", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ staleCheckUser: [staleCheckUserRow(200)] }));
    fetchPullRequestsForHead.mockResolvedValue([
      { state: "closed", merged_at: CHECK_USER_MERGED_AT },
    ]);
    // 404（もともと付いていない）
    removeIssueLabel.mockResolvedValue(null);

    const result = await runProgressSweep({ now: NOW });

    expect(result.actions).toEqual([]);
  });

  it("ラベルの無い手作業Issueへ 71.manual-step を付け直す", async () => {
    fetchProjectItems.mockResolvedValue([]);
    issueFindMany.mockImplementation(issueRowsFor({ manualStep: [manualStepRow(40)] }));

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
    issueFindMany.mockImplementation(issueRowsFor({ manualStep: [manualStepRow(40)] }));

    const result = await runProgressSweep({ now: NOW });

    expect(addIssueLabels).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it("Project連携が無効でも手作業ラベルの埋め直しは行う", async () => {
    delete process.env.PROJECT_V2_OWNER;
    issueFindMany.mockImplementation(issueRowsFor({ manualStep: [manualStepRow(40)] }));

    const result = await runProgressSweep({ now: NOW });

    expect(fetchProjectItems).not.toHaveBeenCalled();
    expect(result.candidates).toBe(0);
    expect(result.actions).toHaveLength(1);
  });

  describe("closedなIssueの取り残し回収（#2690）", () => {
    function closedProjectItem(overrides: Record<string, unknown> = {}) {
      return {
        itemId: "item-2",
        repositoryDatabaseId: 555,
        issueNumber: 3000,
        issueOpen: false,
        status: "Release",
        ...overrides,
      };
    }

    beforeEach(() => {
      // openなIssue向けの既定候補と混ざらないよう、closed専用のアイテムだけにする
      fetchProjectItems.mockResolvedValue([closedProjectItem()]);
      compareBranches.mockResolvedValue({ aheadBy: 0, changedFiles: null, lastCommitAt: null });
    });

    it("mainの祖先になっていればdoneを報告し、確認待ちも外してコメントする", async () => {
      const result = await runProgressSweep({ now: NOW });

      expect(result.closedCandidates).toBe(1);
      expect(compareBranches).toHaveBeenCalledWith(
        "guchi-apps",
        "issue-deck",
        "main",
        "aaa111",
        "token",
      );
      expect(reportProgressStatus).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 3000,
        status: "done",
        onlyFrom: ["develop", "release"],
      });
      expect(removeIssueLabel).toHaveBeenCalledWith(
        "guchi-apps",
        "issue-deck",
        3000,
        "token",
        "00.check-user",
      );
      expect(createComment.mock.calls.at(-1)?.[4].body).toContain("Done へ進めました");
      expect(result.actions).toContainEqual({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 3000,
        kind: "closed_advanced",
      });
    });

    it("まだmainの祖先になっていなければ見送る（次のリリース待ち）", async () => {
      compareBranches.mockResolvedValue({ aheadBy: 2, changedFiles: 3, lastCommitAt: null });

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ closed_not_in_main_yet: 1 });
      expect(reportProgressStatus).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    });

    it("developへのマージ済みPRが無ければ見送り、mainとの比較もしない", async () => {
      fetchPullRequestsForHead.mockImplementation(pullRequestsForHead([]));

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ closed_no_merged_pr: 1 });
      expect(compareBranches).not.toHaveBeenCalled();
      expect(reportProgressStatus).not.toHaveBeenCalled();
    });

    it("進捗の報告が反映されなければ通知もラベル除去も行わない", async () => {
      reportProgressStatus.mockResolvedValue({ applied: false, reason: "status_mismatch" });

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ action_failed: 1 });
      expect(removeIssueLabel).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
      expect(result.actions).toEqual([]);
    });
  });

  describe("本番反映済みなのにopenのまま残ったIssueのclose（#2715）", () => {
    function mergedOpenItem(overrides: Record<string, unknown> = {}) {
      return {
        itemId: "item-3",
        repositoryDatabaseId: 555,
        issueNumber: 2700,
        issueOpen: true,
        status: "Develop",
        ...overrides,
      };
    }

    beforeEach(() => {
      fetchProjectItems.mockResolvedValue([mergedOpenItem()]);
      compareBranches.mockResolvedValue({ aheadBy: 0, changedFiles: null, lastCommitAt: null });
      reportProgressStatus.mockResolvedValue({ applied: true, from: "Develop", to: "Done" });
    });

    it("Developのままmainへ入っていればdoneを報告してからcloseし、コメントを残す", async () => {
      const result = await runProgressSweep({ now: NOW });

      expect(result.mergedOpenCandidates).toBe(1);
      expect(compareBranches).toHaveBeenCalledWith(
        "guchi-apps",
        "issue-deck",
        "main",
        "aaa111",
        "token",
      );
      expect(reportProgressStatus).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2700,
        status: "done",
        onlyFrom: ["develop", "release"],
      });
      expect(updateIssue).toHaveBeenCalledWith("guchi-apps", "issue-deck", 2700, "token", {
        state: "closed",
        state_reason: "completed",
      });
      expect(removeIssueLabel).toHaveBeenCalledWith(
        "guchi-apps",
        "issue-deck",
        2700,
        "token",
        "00.check-user",
      );
      expect(createComment.mock.calls.at(-1)?.[4].body).toContain("Done へ進めて");
      expect(result.actions).toContainEqual({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2700,
        kind: "open_closed",
      });
    });

    it("報告はcloseより先に行う（closeが先だと終端Closedへ落ちうる）", async () => {
      const order: string[] = [];
      reportProgressStatus.mockImplementation(async () => {
        order.push("report");
        return { applied: true, from: "Develop", to: "Done" };
      });
      updateIssue.mockImplementation(async () => {
        order.push("close");
        return {};
      });

      await runProgressSweep({ now: NOW });

      expect(order).toEqual(["report", "close"]);
    });

    it("Doneのままopenなものは、PR・比較を1回も引かずにcloseする", async () => {
      fetchProjectItems.mockResolvedValue([mergedOpenItem({ status: "Done", issueNumber: 2690 })]);

      const result = await runProgressSweep({ now: NOW });

      expect(fetchPullRequestsForHead).not.toHaveBeenCalled();
      expect(compareBranches).not.toHaveBeenCalled();
      expect(reportProgressStatus).not.toHaveBeenCalled();
      expect(updateIssue).toHaveBeenCalledWith("guchi-apps", "issue-deck", 2690, "token", {
        state: "closed",
        state_reason: "completed",
      });
      expect(result.actions).toContainEqual({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2690,
        kind: "open_closed",
      });
    });

    it("まだmainへ入っていなければ見送る（次のリリース待ち＝正常）", async () => {
      compareBranches.mockResolvedValue({ aheadBy: 2, changedFiles: 3, lastCommitAt: null });

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ open_not_in_main_yet: 1 });
      expect(updateIssue).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    });

    it("人がreopenしたIssueは閉じ直さない", async () => {
      hasReopenedEvent.mockResolvedValue(true);

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ open_reopened: 1 });
      expect(reportProgressStatus).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();
    });

    it("reopenの有無を確かめられなければ閉じない", async () => {
      hasReopenedEvent.mockResolvedValue(null);

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ open_reopen_unknown: 1 });
      expect(updateIssue).not.toHaveBeenCalled();
    });

    it("見送るだけの巡回ではreopenの確認を行わない", async () => {
      compareBranches.mockResolvedValue({ aheadBy: 2, changedFiles: 3, lastCommitAt: null });

      await runProgressSweep({ now: NOW });

      expect(hasReopenedEvent).not.toHaveBeenCalled();
    });

    it("ローカルセッションが走っているIssueは閉じない（追加対応の途中で驚かせない）", async () => {
      dispatchSessionFindMany.mockResolvedValue([
        { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 2700 },
      ]);

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ open_session_alive: 1 });
      expect(fetchPullRequestsForHead).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();
    });

    it("closeに失敗したらコメントは残さない", async () => {
      updateIssue.mockRejectedValue(new Error("boom"));

      const result = await runProgressSweep({ now: NOW });

      expect(result.skipped).toMatchObject({ action_failed: 1 });
      expect(createComment).not.toHaveBeenCalled();
      expect(result.actions).toEqual([]);
    });
  });
});
