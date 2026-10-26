import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchOpenPullRequestsForBase = vi.fn();
const fetchRefCheckState = vi.fn();
const fetchLatestReleaseWorkflowRun = vi.fn();
const fetchLatestDeployWorkflowRun = vi.fn();
const releaseWorkflowExists = vi.fn();
const fetchReleaseChecks = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return findMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/release-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/release-api")>();
  return {
    ...actual,
    get fetchOpenPullRequestsForBase() {
      return fetchOpenPullRequestsForBase;
    },
    get fetchRefCheckState() {
      return fetchRefCheckState;
    },
    get fetchLatestReleaseWorkflowRun() {
      return fetchLatestReleaseWorkflowRun;
    },
    get fetchLatestDeployWorkflowRun() {
      return fetchLatestDeployWorkflowRun;
    },
  };
});

vi.mock("@/lib/pull-request-release-checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pull-request-release-checks")>();
  return {
    ...actual,
    get fetchReleaseChecks() {
      return fetchReleaseChecks;
    },
  };
});

vi.mock("@/lib/github/release-workflow-cache", () => ({
  get releaseWorkflowExists() {
    return releaseWorkflowExists;
  },
}));

import { GET } from "@/app/api/repositories/release-pending-merges/route";
import { MERGE_JUDGEMENT_UNKNOWN, type MergeJudgement } from "@/lib/github/check-rollup";
import type { CiState, RefCheckState } from "@/lib/github/release-api";
import type { PullRequestReleaseChecks, ReleaseRcFacts } from "@/types/pull-request";

/** リリースPR #12の検証状態を返す`fetchReleaseChecks`の実装（#4390） */
function releaseChecksOf(checks: PullRequestReleaseChecks) {
  return async () => new Map([["owner/repo-a#12", checks]]);
}

/** 検証中（review）の新方式の候補の記録（#5076） */
const RC_REVIEW: ReleaseRcFacts = {
  sequence: 11,
  phase: "review",
  pendingRevision: null,
  approval: null,
  finalization: null,
  productionStopLabel: null,
  predecessor: null,
  updatedAt: "2026-10-26T12:00:00.000Z",
};

const CHECKS_PASSED: PullRequestReleaseChecks = {
  aiReview: "passed",
  integration: "passed",
  enforced: false,
  started: { aiReview: false, integration: false, mac: false },
  integrationSetupGap: null,
};

const REPO_A = {
  fullName: "owner/repo-a",
  ownerLogin: "owner",
  name: "repo-a",
  installation: { installationId: 111 },
};
const REPO_B = {
  fullName: "owner/repo-b",
  ownerLogin: "owner",
  name: "repo-b",
  installation: { installationId: 111 },
};

/** 指定したリポジトリ・baseにだけPRを返すモック実装を作る */
function openPullRequestsFor(target: {
  repo: string;
  base: string;
  pullRequest: { number: number; html_url: string; title: string; head: { ref: string }; draft?: boolean };
}) {
  return async (_owner: string, repo: string, base: string) =>
    repo === target.repo && base === target.base ? [target.pullRequest] : [];
}

/**
 * `fetchRefCheckState`の戻り値。CI状態と自動マージ可否の判定を同じ1回のクエリで返す（#2326）。
 * 既定は判定のcheck-runを持たない（`unknown`）リポジトリ＝従来どおりの振る舞い。
 */
function checkState(
  ciState: CiState,
  mergeJudgement: MergeJudgement = MERGE_JUDGEMENT_UNKNOWN,
): RefCheckState {
  return { ciState, mergeJudgement };
}

/** `claude-review-develop.yml`のレビューが走っている最中（#2326） */
const PENDING_JUDGEMENT: MergeJudgement = {
  state: "pending",
  step: "claude-review",
  runUrl: null,
  aiReview: { state: "pending", runUrl: null },
};

const RELEASE_PR = {
  number: 12,
  html_url: "https://github.com/owner/repo-a/pull/12",
  title: "release",
  // リリースPRのheadは固定ブランチ`release-main/vX.Y.Z`（#2117）
  head: { ref: "release-main/v1.2.3" },
};
const BUMP_PR = {
  number: 34,
  html_url: "https://github.com/owner/repo-a/pull/34",
  title: "release/v1.2.3",
  head: { ref: "release/v1.2.3" },
};

describe("GET /api/repositories/release-pending-merges", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findMany.mockReset().mockResolvedValue([REPO_A, REPO_B]);
    getInstallationToken.mockReset().mockResolvedValue("token");
    releaseWorkflowExists.mockReset().mockResolvedValue(true);
    fetchOpenPullRequestsForBase.mockReset().mockResolvedValue([]);
    fetchRefCheckState.mockReset().mockResolvedValue(checkState("success"));
    fetchLatestReleaseWorkflowRun.mockReset().mockResolvedValue(null);
    fetchLatestDeployWorkflowRun.mockReset().mockResolvedValue(null);
    fetchReleaseChecks.mockReset().mockImplementation(releaseChecksOf(CHECKS_PASSED));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未ログインの場合は401を返す", async () => {
    requireUserId.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("develop→mainのPRがオープン中のリポジトリはmainへのマージ待ちとして返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: {
          mergeTarget: "main",
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/owner/repo-a/pull/12",
          pullRequestTitle: "release",
          ciState: "success",
          actionLabel: null,
        },
      },
    ]);
    // CI状態はリリースPRのheadブランチ（凍結ブランチ）に対して問い合わせる。
    expect(fetchRefCheckState).toHaveBeenCalledWith("owner", "repo-a", "release-main/v1.2.3", "token");
  });

  it("リリースPRのCIが失敗していても一覧から外さず、ciStateにfailureを返す（#1059）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("failure"));

    const response = await GET();
    const json = await response.json();

    // バンプPRと違い、CIが通っていないことを理由に一覧から落とさない。
    // マージできない状態にあること自体を画面へ出すのが目的のため。
    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: {
          mergeTarget: "main",
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/owner/repo-a/pull/12",
          pullRequestTitle: "release",
          ciState: "failure",
          actionLabel: null,
        },
      },
    ]);
  });

  it("draftのリリース候補はチェックを読まず、ブランチ画面と同じくマージ待ちとして返す（#4916）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({
        repo: "repo-a",
        base: "main",
        pullRequest: { ...RELEASE_PR, head: { ref: "release-rc/11" }, draft: true },
      }),
    );
    // 正式バンプ前の候補では`version-tag-check`が落ちている。読めば「チェック失敗」になる
    fetchRefCheckState.mockResolvedValue(checkState("failure"));
    // 検証に合格した新方式の候補は、工程（#5076）で公開承認があなたの番になる
    fetchReleaseChecks.mockImplementation(releaseChecksOf({ ...CHECKS_PASSED, rc: RC_REVIEW }));

    const response = await GET();
    const json = await response.json();

    expect(fetchRefCheckState).not.toHaveBeenCalled();
    expect(json.releaseStatuses).toEqual([
      expect.objectContaining({
        repoFullName: "owner/repo-a",
        status: "action_required",
        pendingMerge: expect.objectContaining({ mergeTarget: "main", ciState: "unknown", actionLabel: "公開承認待ち" }),
      }),
    ]);
  });

  it("公開承認済みで自動公開を待つ新方式の候補は、人の番として数えない（#5076）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: { ...RELEASE_PR, head: { ref: "release-rc/11" } } }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("success"));
    fetchReleaseChecks.mockImplementation(
      releaseChecksOf({
        ...CHECKS_PASSED,
        publishApproved: true,
        rc: {
          ...RC_REVIEW,
          phase: "awaiting_approval",
          approval: {
            status: "active",
            progress: "auto_publish",
            approvedAt: "2026-10-26T12:00:00.000Z",
            revision: 1,
            invalidMessage: null,
            runStatus: "merging",
            runActive: true,
            waitMessage: null,
            waitStalled: false,
            stopMessage: null,
          },
        },
      }),
    );

    const json = await (await GET()).json();

    expect(json.releaseStatuses[0]?.pendingMerge ?? null).toBeNull();
  });

  it("draftのバンプPRもチェックを読まない（#4916）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "develop", pullRequest: { ...BUMP_PR, draft: true } }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("failure"));

    const response = await GET();
    const json = await response.json();

    expect(fetchRefCheckState).not.toHaveBeenCalled();
    expect(json.releaseStatuses[0]?.pendingMerge).toEqual(
      expect.objectContaining({ mergeTarget: "develop", ciState: "unknown" }),
    );
  });

  it("リリースPRのCIがpending中はマージ待ちではなく実行中として返す（#1433）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("pending"));

    const response = await GET();
    const json = await response.json();

    // CI実行中はまだマージできないため、ヘッダーのオレンジのバッジ件数から外す。
    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
    ]);
  });

  /**
   * CI通過後にClaudeのレビュー・マージ可否の判定が走っている窓（#2326）。判定のcheck-runは
   * CI状態の集約から外してある（#1799）ため`ciState`は`success`のまま。押せる操作が無い
   * あいだは通知ベル・スマホの一覧・フッターの件数から外す。
   */
  it("リリースPRの自動マージ可否の判定中はマージ待ちにしない（#2326）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("success", PENDING_JUDGEMENT));

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
    ]);
  });

  it("全体レビューが実行中のリリース候補はマージ待ちにせず、リリース検証中として返す（#4390）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchReleaseChecks.mockImplementation(
      releaseChecksOf({
        ...CHECKS_PASSED,
        aiReview: "running",
        integration: "not_applicable",
        started: { aiReview: true, integration: false, mac: false },
      }),
    );

    const json = await (await GET()).json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
        verification: { block: "progressing", label: "リリース検証中", detail: "全体レビューの実行中です" },
      },
    ]);
  });

  it("統合検証の設定不足は理由付きの要対応として返し、マージ待ちにしない（#4390）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchReleaseChecks.mockImplementation(
      releaseChecksOf({ ...CHECKS_PASSED, integration: "failed", integrationSetupGap: "コマンド未設定" }),
    );

    const json = await (await GET()).json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: null,
        verification: { block: "problem", label: "検証の設定不足", detail: "統合検証: コマンド未設定" },
      },
    ]);
  });

  it("検証の記録を読めないリリース候補はマージ待ちにしない（#4390）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );
    fetchReleaseChecks.mockResolvedValue(new Map());

    const json = await (await GET()).json();

    expect(json.releaseStatuses[0].pendingMerge).toBeNull();
    expect(json.releaseStatuses[0].verification.label).toBe("検証状態を取得できません");
  });

  it("バンプPRがCI通過後も残っているリポジトリはdevelopへのマージ待ちとして返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "develop", pullRequest: BUMP_PR }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("success"));

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: {
          mergeTarget: "develop",
          pullRequestNumber: 34,
          pullRequestUrl: "https://github.com/owner/repo-a/pull/34",
          pullRequestTitle: "release/v1.2.3",
          ciState: "success",
          actionLabel: null,
        },
      },
    ]);
  });

  it("バンプPRのCIがpending中はマージ待ちではなく実行中として返す（#1117）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "develop", pullRequest: BUMP_PR }),
    );
    fetchRefCheckState.mockResolvedValue(checkState("pending"));

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
    ]);
  });

  it("リリースworkflowが実行中のリポジトリはPRが無くても実行中として返す（#1117）", async () => {
    fetchLatestReleaseWorkflowRun.mockImplementation(async (_owner: string, repo: string) =>
      repo === "repo-a" ? { status: "in_progress", conclusion: null } : null,
    );

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
    ]);
  });

  it("本番デプロイが失敗しているリポジトリはfailedWorkflow: deployとして返す（#1117）", async () => {
    fetchLatestDeployWorkflowRun.mockImplementation(async (_owner: string, repo: string) =>
      repo === "repo-a" ? { status: "completed", conclusion: "failure" } : null,
    );

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-a",
        status: "error",
        failedWorkflow: "deploy",
        pendingMerge: null,
      },
    ]);
  });

  it("動きが無い（idle）リポジトリは返さない", async () => {
    fetchLatestReleaseWorkflowRun.mockResolvedValue({ status: "completed", conclusion: "success" });
    fetchLatestDeployWorkflowRun.mockResolvedValue({ status: "completed", conclusion: "success" });

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([]);
  });

  it("リリースworkflowが存在しないリポジトリは対象外にする", async () => {
    releaseWorkflowExists.mockResolvedValue(false);

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([]);
    expect(fetchOpenPullRequestsForBase).not.toHaveBeenCalled();
    // 実行状況の取得もworkflowが無いリポジトリでは走らせない（API消費を増やさない）。
    expect(fetchLatestReleaseWorkflowRun).not.toHaveBeenCalled();
    expect(fetchLatestDeployWorkflowRun).not.toHaveBeenCalled();
  });

  it("無人実行のworkflow（claude-issue-dispatch.yml）の有無では母集団を絞らない（#1727）", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      openPullRequestsFor({ repo: "repo-a", base: "main", pullRequest: RELEASE_PR }),
    );

    const response = await GET();
    const json = await response.json();

    // 絞り込みはアーカイブ済みかどうかとインストールの所属だけ。リリースworkflowを持つ
    // かどうかは後段の`releaseWorkflowExists`が決める（無人実行を入れずリリースフローだけを
    // 載せた`subpc`・`vps`が通知から抜け落ちないようにするため）。
    const where = findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("hasClaudeWorkflow");
    expect(where.archived).toBe(false);
    expect(json.releaseStatuses).toHaveLength(1);
  });

  it("同一installationのトークン取得は1回に抑える", async () => {
    await GET();

    expect(getInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("1リポジトリの取得に失敗しても他のリポジトリの結果は返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(
      async (_owner: string, repo: string, base: string) => {
        if (repo === "repo-a") throw new Error("boom");
        if (base === "main" && repo === "repo-b") {
          return [
            {
              number: 3,
              html_url: "https://github.com/owner/repo-b/pull/3",
              title: "release",
              // 共有ワークフローの参照タグが古いリポジトリのリリースPR（head=develop）も
              // 従来どおり検出できること（#2117）
              head: { ref: "develop" },
            },
          ];
        }
        return [];
      },
    );

    const response = await GET();
    const json = await response.json();

    expect(json.releaseStatuses).toEqual([
      {
        repoFullName: "owner/repo-b",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: {
          mergeTarget: "main",
          pullRequestNumber: 3,
          pullRequestUrl: "https://github.com/owner/repo-b/pull/3",
          pullRequestTitle: "release",
          ciState: "success",
          actionLabel: null,
        },
      },
    ]);
  });
});
