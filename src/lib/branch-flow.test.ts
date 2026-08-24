import { describe, expect, it } from "vitest";

import {
  buildBranchFlow,
  extractManualStepOrigin,
  isClosedLane,
  latestReleaseMergedAtByRepository,
  orderRepositoriesBySelection,
  type BranchFlowIssueSource,
} from "@/lib/branch-flow";
import type {
  BranchFlowDeployRun,
  BranchFlowLane,
  BranchFlowRepository,
  RepositoryBranchStatus,
  RepositoryDeployStatus,
} from "@/types/branch-flow";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * レーンはバージョンごとの束へ分かれて返るため（#1510）、
 * 束の分かれ方に関心が無いテストはここで平らに戻す。
 */
function allLanes(repository: BranchFlowRepository): BranchFlowLane[] {
  return [
    ...repository.activeLanes,
    ...repository.releaseGroups.flatMap((group) => group.lanes),
    ...repository.unassignedLanes,
  ];
}

const REPO = "guchi-apps/issue-deck";

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  const headRef = overrides.headRef ?? "issue-100";
  const baseRef = overrides.baseRef ?? "develop";
  return {
    id: `${REPO}#${overrides.number ?? 1}`,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    number: 1,
    title: "実装する",
    htmlUrl: `https://github.com/${REPO}/pull/1`,
    authorLogin: "guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef,
    headRef,
    kind: "issue",
    linkedIssueNumber: 100,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function issue(overrides: Partial<BranchFlowIssueSource> = {}): BranchFlowIssueSource {
  return {
    number: 100,
    title: "実装する",
    repositoryFullName: REPO,
    state: "open",
    projectStatus: "Implementation",
    ...overrides,
  };
}

function branchStatus(overrides: Partial<RepositoryBranchStatus> = {}): RepositoryBranchStatus {
  return {
    repositoryFullName: REPO,
    checkedBranches: ["main", "develop"],
    existingBranches: ["main", "develop"],
    developVsMain: null,
    hasReleaseWorkflow: false,
    hasDeployWorkflow: false,
    ...overrides,
  };
}

const REPOSITORIES = [{ fullName: REPO, private: false }];

function build(input: {
  pullRequests?: PullRequestSummary[];
  issues?: BranchFlowIssueSource[];
  branchStatuses?: RepositoryBranchStatus[];
  deployStatuses?: RepositoryDeployStatus[];
  now?: number;
}) {
  return buildBranchFlow({
    repositories: REPOSITORIES,
    pullRequests: input.pullRequests ?? [],
    issues: input.issues ?? [],
    branchStatuses: input.branchStatuses ?? [],
    deployStatuses: input.deployStatuses,
    now: input.now,
  });
}

describe("buildBranchFlow", () => {
  it("PRの無いブランチもレーンとして出し、ブランチ名からIssueを引く", () => {
    const flow = build({
      issues: [issue({ number: 1455, title: "可視化する" })],
      branchStatuses: [
        branchStatus({
          checkedBranches: ["main", "develop", "issue-1455"],
          existingBranches: ["main", "develop", "issue-1455"],
        }),
      ],
    });

    const [repository] = flow.repositories;
    expect(allLanes(repository)).toHaveLength(1);
    expect(allLanes(repository)[0]).toMatchObject({
      branchName: "issue-1455",
      status: "no-pull-request",
      kind: "issue",
    });
    expect(allLanes(repository)[0].issue).toMatchObject({
      number: 1455,
      title: "可視化する",
      progress: "implementation",
    });
    // ブランチが見つかっているIssueは「関連が切れている」側には出さない
    expect(repository.orphanIssues).toEqual([]);
  });

  it("マージ済みのブランチが残っていても、状態はmergedのまま扱う", () => {
    // マージ後のブランチ削除を自動化していないため残っているのが常態で、区別しても情報にならない
    const merged = pullRequest({
      state: "closed",
      merged: true,
      headRef: "issue-1400",
      linkedIssueNumber: 1400,
    });

    const left = build({
      pullRequests: [merged],
      branchStatuses: [
        branchStatus({
          checkedBranches: ["issue-1400"],
          existingBranches: ["issue-1400"],
        }),
      ],
    });
    expect(allLanes(left.repositories[0])[0].status).toBe("merged");
  });

  it("ブランチ状況を取得できなかったリポジトリでも、PRだけで組み立てる", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ state: "closed", merged: true, headRef: "issue-1400", linkedIssueNumber: 1400 }),
      ],
      branchStatuses: [],
    });

    expect(flow.repositories[0].branchesLoaded).toBe(false);
    expect(allLanes(flow.repositories[0])[0].status).toBe("merged");
  });

  it("未マージでクローズされたPRはclosedになる", () => {
    const flow = build({
      pullRequests: [pullRequest({ state: "closed", merged: false })],
      branchStatuses: [branchStatus()],
    });
    expect(allLanes(flow.repositories[0])[0].status).toBe("closed");
  });

  it("同じブランチに複数のPRがあるとき、生きているPRを先頭に置く", () => {
    const flow = build({
      pullRequests: [
        pullRequest({
          number: 10,
          state: "closed",
          merged: false,
          updatedAt: "2026-08-05T00:00:00Z",
        }),
        pullRequest({ number: 11, state: "open", updatedAt: "2026-08-02T00:00:00Z" }),
      ],
      branchStatuses: [branchStatus({ checkedBranches: ["issue-100"], existingBranches: ["issue-100"] })],
    });

    const [lane] = allLanes(flow.repositories[0]);
    expect(lane.pullRequests.map((item) => item.number)).toEqual([11, 10]);
    expect(lane.status).toBe("open");
  });

  it("1つのIssueから別々のブランチでPRが作られた場合、レーンはブランチごとに分かれる", () => {
    const flow = build({
      issues: [issue({ number: 1455, title: "可視化する" })],
      pullRequests: [
        pullRequest({ number: 10, headRef: "issue-1455", linkedIssueNumber: 1455 }),
        // 規約から外れたブランチ。タイトルの`#1455`から同じIssueへ紐づく
        pullRequest({
          number: 11,
          headRef: "fix/1455-followup",
          kind: "other",
          title: "#1455 の追従",
          linkedIssueNumber: 1455,
        }),
      ],
      branchStatuses: [branchStatus()],
    });

    const lanes = allLanes(flow.repositories[0]);
    expect(lanes.map((lane) => lane.branchName).sort()).toEqual(["fix/1455-followup", "issue-1455"]);
    // どちらのレーンも同じIssueを指す
    expect(lanes.every((lane) => lane.issue?.number === 1455)).toBe(true);
  });

  it("1本のPRが複数のIssueを扱う場合、2件目以降は関連Issueとして出す", () => {
    const flow = build({
      issues: [
        issue({ number: 1455, title: "可視化する" }),
        issue({ number: 1460, title: "一緒に直す" }),
      ],
      pullRequests: [
        pullRequest({
          number: 10,
          headRef: "issue-1455",
          linkedIssueNumber: 1455,
          linkedIssueNumbers: [1455, 1460],
        }),
      ],
      branchStatuses: [branchStatus()],
    });

    const [lane] = allLanes(flow.repositories[0]);
    expect(lane.issue?.number).toBe(1455);
    expect(lane.relatedIssues.map((item) => item.number)).toEqual([1460]);
    // 関連として出したIssueは「ブランチもPRも見つからない」側へ重複させない
    expect(flow.repositories[0].orphanIssues).toEqual([]);
  });

  it("対応Issueを特定できないPRはissueがnullになる", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ headRef: "hotfix/typo", kind: "other", linkedIssueNumber: null }),
      ],
      branchStatuses: [branchStatus()],
    });

    expect(allLanes(flow.repositories[0])[0]).toMatchObject({
      branchName: "hotfix/typo",
      issue: null,
      kind: "other",
    });
  });

  it("DBキャッシュに無いIssueでも番号だけは残す", () => {
    const flow = build({
      pullRequests: [pullRequest({ linkedIssueNumber: 999 })],
      branchStatuses: [branchStatus()],
    });

    expect(allLanes(flow.repositories[0])[0].issue).toEqual({
      number: 999,
      title: null,
      progress: null,
      state: null,
    });
  });

  it("リリースPRは作業レーンではなく幹に置く", () => {
    const release = pullRequest({
      number: 500,
      baseRef: "main",
      headRef: "develop",
      kind: "release",
      linkedIssueNumber: null,
    });

    const flow = build({
      pullRequests: [release],
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 12, behindBy: 0 } })],
    });

    const [repository] = flow.repositories;
    expect(repository.release.pullRequest?.number).toBe(500);
    expect(repository.release.comparison).toEqual({ aheadBy: 12, behindBy: 0 });
    expect(allLanes(repository)).toEqual([]);
    // 幹に置いたリリースPRは、未リリースの束の見出しとして出す
    expect(repository.releaseGroups[0].pullRequest?.number).toBe(500);
    expect(repository.summary.releaseInProgress).toBe(true);
  });

  it("バージョンバンプのブランチも規約どおり分類する", () => {
    const flow = build({
      branchStatuses: [branchStatus({ checkedBranches: ["release/v3.18.0"], existingBranches: ["release/v3.18.0"] })],
    });
    expect(allLanes(flow.repositories[0])[0].kind).toBe("version-bump");
  });

  it("実装中なのにブランチもPRも無いIssueを別枠で出す", () => {
    const flow = build({
      issues: [
        issue({ number: 1450, projectStatus: "Implementation" }),
        issue({ number: 1451, projectStatus: "Develop PR" }),
        // 計画中はまだブランチが無くて当然なので対象外
        issue({ number: 1452, projectStatus: "Planning" }),
        // developマージ済みはブランチが消えているのが正常
        issue({ number: 1453, projectStatus: "Develop" }),
        // closeされたIssueは追わない
        issue({ number: 1454, projectStatus: "Implementation", state: "closed" }),
      ],
      branchStatuses: [branchStatus()],
    });

    expect(flow.repositories[0].orphanIssues.map((item) => item.number)).toEqual([1451, 1450]);
  });

  it("レーンは手を動かすべきものから順に並ぶ", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ number: 1, headRef: "issue-1", linkedIssueNumber: 1, state: "open" }),
        pullRequest({
          number: 2,
          headRef: "issue-2",
          linkedIssueNumber: 2,
          state: "closed",
          merged: true,
        }),
      ],
      branchStatuses: [
        branchStatus({
          checkedBranches: ["issue-1", "issue-3"],
          existingBranches: ["issue-1", "issue-3"],
        }),
      ],
    });

    // マージ済みのレーンはバージョンの束へ移るので、上段に残るのは流れている作業だけ
    expect(flow.repositories[0].activeLanes.map((lane) => lane.status)).toEqual([
      "open",
      "no-pull-request",
    ]);
    expect(allLanes(flow.repositories[0]).map((lane) => lane.status)).toContain("merged");
  });

  it("動きの無いリポジトリも1行ぶんは返す（既定で畳むので隠す理由が無い）", () => {
    const flow = buildBranchFlow({
      repositories: [
        { fullName: REPO, private: false },
        { fullName: "guchi-apps/quiet", private: false },
      ],
      pullRequests: [pullRequest()],
      issues: [],
      branchStatuses: [
        branchStatus({ checkedBranches: ["issue-100"], existingBranches: ["issue-100"] }),
        {
          repositoryFullName: "guchi-apps/quiet",
          checkedBranches: ["main", "develop"],
          existingBranches: ["main", "develop"],
          developVsMain: { aheadBy: 0, behindBy: 0 },
          hasReleaseWorkflow: false,
          hasDeployWorkflow: false,
        },
      ],
    });

    expect(flow.repositories.map((item) => item.repositoryFullName)).toEqual([
      REPO,
      "guchi-apps/quiet",
    ]);
    const quiet = flow.repositories[1];
    expect(quiet.activeLanes).toEqual([]);
    expect(quiet.releaseGroups).toEqual([]);
    expect(quiet.summary).toEqual({
      activeLaneCount: 0,
      hasCiFailure: false,
      needsUserMerge: false,
      openManualStepCount: 0,
      plannedIssueCount: 0,
      releaseInProgress: false,
      releaseCiPending: false,
      releaseMergeTarget: null,
      deploy: null,
    });
  });

  it("未リリースの変更があれば、レーンが無くても未リリースの束を作る", () => {
    const flow = build({
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
    });
    expect(flow.repositories[0].releaseGroups).toHaveLength(1);
    expect(flow.repositories[0].releaseGroups[0]).toMatchObject({
      key: "unreleased",
      mergedAt: null,
      lanes: [],
    });
  });

  it("マージ済みの作業が、どのバージョンで本番へ出たかを解決する", () => {
    const flow = build({
      pullRequests: [
        // 古いリリース（比較の下限になる）
        pullRequest({
          number: 900,
          title: "v3.16.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
        pullRequest({
          number: 950,
          title: "v3.17.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
        // v3.17.0のリリース前にdevelopへ入った作業 → v3.17.0で本番へ出ている
        pullRequest({
          number: 910,
          headRef: "issue-910",
          linkedIssueNumber: 910,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-05T00:00:00Z",
        }),
        // 最新リリースより後にdevelopへ入った作業 → まだ本番へ出ていない
        pullRequest({
          number: 960,
          headRef: "issue-960",
          linkedIssueNumber: 960,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-12T00:00:00Z",
        }),
        // さらに古いマージ → 直後のリリース（v3.16.0）で本番へ出ている
        pullRequest({
          number: 800,
          headRef: "issue-800",
          linkedIssueNumber: 800,
          state: "closed",
          merged: true,
          mergedAt: "2026-07-20T00:00:00Z",
        }),
      ],
      branchStatuses: [branchStatus()],
    });

    const byBranch = new Map(allLanes(flow.repositories[0]).map((lane) => [lane.branchName, lane]));
    expect(byBranch.get("issue-910")?.releaseState).toEqual({
      kind: "released",
      version: "3.17.0",
      pullRequestNumber: 950,
    });
    expect(byBranch.get("issue-960")?.releaseState).toEqual({ kind: "pending" });
    expect(byBranch.get("issue-800")?.releaseState).toEqual({
      kind: "released",
      version: "3.16.0",
      pullRequestNumber: 900,
    });
    // mainの現在の版は、マージ済みリリースPRのうち最も新しいもの
    expect(flow.repositories[0].release.latestVersion).toBe("3.17.0");
  });

  it("マージされていないレーンは本番反映の判定を持たない", () => {
    const flow = build({
      pullRequests: [pullRequest({ state: "open" })],
      branchStatuses: [branchStatus({ checkedBranches: ["issue-100"], existingBranches: ["issue-100"] })],
    });
    expect(allLanes(flow.repositories[0])[0].releaseState).toBeNull();
  });

  it("リリースPRを1件も取得できていないときは版を断定しない", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ state: "closed", merged: true, mergedAt: "2026-08-05T00:00:00Z" }),
      ],
      branchStatuses: [branchStatus()],
    });
    expect(allLanes(flow.repositories[0])[0].releaseState).toEqual({ kind: "unknown" });
    expect(flow.repositories[0].release.latestVersion).toBeNull();
    // 版が分からないレーンは、どの束にも入れずに別枠へ出す
    expect(flow.repositories[0].unassignedLanes).toHaveLength(1);
    expect(flow.repositories[0].releaseGroups).toEqual([]);
  });

  it("存在を確認できなかったブランチはレーンを作らない", () => {
    // 進行中のIssueぶんを問い合わせて見つからなかった場合。ブランチもPRも無いので
    // レーンではなく「関連が見つからないIssue」側に出る。
    const flow = build({
      issues: [issue({ number: 1470 })],
      branchStatuses: [
        branchStatus({ checkedBranches: ["issue-1470"], existingBranches: [] }),
      ],
    });

    expect(allLanes(flow.repositories[0])).toEqual([]);
    expect(flow.repositories[0].orphanIssues.map((item) => item.number)).toEqual([1470]);
  });
});


/**
 * `asset-manager`の実データと同じ形（#1510）。
 * v3.8.6 に #182・#181・#180、v3.8.5 に #177・#176 が乗り、
 * v3.8.6のリリースPR #183 はまだopen。
 */
function releasePullRequest(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return pullRequest({
    baseRef: "main",
    headRef: "develop",
    kind: "release",
    linkedIssueNumber: null,
    ...overrides,
  });
}

describe("バージョンごとの束（releaseGroups）", () => {
  const flow = build({
    pullRequests: [
      releasePullRequest({
        number: 183,
        title: "v3.8.6をmainへリリースする",
        state: "open",
        ciState: "pending",
      }),
      releasePullRequest({
        number: 178,
        title: "v3.8.5をmainへリリースする",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-14T12:00:00Z",
      }),
      // v3.8.6に乗る（v3.8.5のリリース後にdevelopへ入った）
      pullRequest({
        number: 182,
        headRef: "release/v3.8.6",
        kind: "version-bump",
        linkedIssueNumber: null,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-15T01:00:00Z",
      }),
      pullRequest({
        number: 181,
        headRef: "issue-137",
        linkedIssueNumber: 137,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-15T00:30:00Z",
      }),
      // v3.8.5に乗った
      pullRequest({
        number: 176,
        headRef: "issue-am",
        linkedIssueNumber: 175,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-14T09:00:00Z",
      }),
      // まだマージしていない
      pullRequest({ number: 187, headRef: "issue-186", linkedIssueNumber: 186, state: "open" }),
    ],
    branchStatuses: [branchStatus({ developVsMain: { aheadBy: 6, behindBy: 26 } })],
  });
  const [repository] = flow.repositories;

  it("未リリースの束を先頭に、本番へ出た束を新しい順に並べる", () => {
    expect(repository.releaseGroups.map((group) => group.version)).toEqual(["3.8.6", "3.8.5"]);
    expect(repository.releaseGroups[0].mergedAt).toBeNull();
    expect(repository.releaseGroups[0].pullRequest?.number).toBe(183);
    expect(repository.releaseGroups[1].mergedAt).toBe("2026-08-14T12:00:00Z");
  });

  it("リリースPRのマージ時刻の前後で、どの束に入るかが決まる", () => {
    // バンプPR（release/v3.8.6）は#1548でレーンから外したため、ここには現れない
    expect(repository.releaseGroups[0].lanes.map((lane) => lane.branchName).sort()).toEqual([
      "issue-137",
    ]);
    expect(repository.releaseGroups[1].lanes.map((lane) => lane.branchName)).toEqual(["issue-am"]);
  });

  it("まだdevelopへ入っていないレーンはどの束にも入れない", () => {
    expect(repository.activeLanes.map((lane) => lane.branchName)).toEqual(["issue-186"]);
    expect(repository.summary.activeLaneCount).toBe(1);
  });
});

describe("isClosedLane", () => {
  it("既定で隠すのは未マージのクローズだけ。マージ済みは束に入るので隠さない", () => {
    const flow = build({
      pullRequests: [
        releasePullRequest({
          number: 900,
          title: "v3.16.0をmainへリリースする",
          state: "closed",
          merged: true,
          mergedAt: "2026-08-05T00:00:00Z",
        }),
        pullRequest({ number: 1, headRef: "issue-1", linkedIssueNumber: 1 }),
        pullRequest({
          number: 2,
          headRef: "issue-2",
          linkedIssueNumber: 2,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
        pullRequest({
          number: 4,
          headRef: "issue-4",
          linkedIssueNumber: 4,
          state: "closed",
          merged: false,
        }),
      ],
      branchStatuses: [branchStatus()],
    });

    const [repository] = flow.repositories;
    expect(repository.activeLanes.filter(isClosedLane).map((lane) => lane.branchName)).toEqual([
      "issue-4",
    ]);
    // 本番へ出たものは畳まず、v3.16.0の束の中に見える
    expect(repository.releaseGroups[0].lanes.map((lane) => lane.branchName)).toEqual(["issue-2"]);
  });
});

describe("手作業Issueの紐づけ", () => {
  const manualStepBody = [
    "## 前提条件",
    "",
    "- 先に #1461 がdevelopへマージされていること",
    "",
    "## 関連",
    "",
    "- 起点Issue #137",
    "- 対応PR #181",
  ].join("\n");

  function buildWithManualStep(overrides: Partial<BranchFlowIssueSource> = {}) {
    return build({
      issues: [
        issue({ number: 137, title: "利用規約を整理" }),
        issue({
          number: 184,
          title: "[手作業] VPS: リダイレクトを外す",
          projectStatus: "Ready",
          labels: ["71.manual-step"],
          body: manualStepBody,
          ...overrides,
        }),
      ],
      pullRequests: [
        pullRequest({
          number: 181,
          headRef: "issue-137",
          linkedIssueNumber: 137,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-15T00:30:00Z",
        }),
      ],
      branchStatuses: [branchStatus()],
    });
  }

  it("本文の「## 関連」が指す起点Issueのレーンへぶら下げる", () => {
    const [repository] = buildWithManualStep().repositories;
    const [lane] = allLanes(repository);
    expect(lane.issue?.number).toBe(137);
    expect(lane.manualSteps).toEqual([
      { number: 184, title: "[手作業] VPS: リダイレクトを外す", state: "open" },
    ]);
  });

  it("束には未完了の手作業の件数を持たせる", () => {
    const open = buildWithManualStep().repositories[0];
    expect(open.unassignedLanes[0].manualSteps).toHaveLength(1);
    // 版を決められないレーンでも紐づけ自体は効く
    const done = buildWithManualStep({ state: "closed" }).repositories[0];
    expect(done.unassignedLanes[0].manualSteps[0].state).toBe("closed");
  });

  it("手作業Issueは「ブランチもPRも見つからないIssue」に混ぜない", () => {
    const flow = build({
      issues: [
        issue({
          number: 184,
          title: "[手作業] VPS: リダイレクトを外す",
          projectStatus: "Implementation",
          labels: ["71.manual-step"],
          body: manualStepBody,
        }),
      ],
      branchStatuses: [branchStatus()],
    });
    expect(flow.repositories[0].orphanIssues).toEqual([]);
  });
});

describe("extractManualStepOrigin", () => {
  it("「## 関連」の最初の#番号を起点として読む", () => {
    const body = [
      "## 前提条件",
      "- #999 がマージ済みであること",
      "## 関連",
      "- 起点Issue #137",
      "- 対応PR #181",
    ].join("\n");
    expect(extractManualStepOrigin(body)).toBe(137);
  });

  it("見出しが無い場合は「起点」を含む行から読む", () => {
    expect(extractManualStepOrigin("起点: #1510\n\n何かの説明 #2000")).toBe(1510);
  });

  it("手掛かりが無ければnull", () => {
    expect(extractManualStepOrigin("VPSで作業する。#999 は無関係。")).toBeNull();
    expect(extractManualStepOrigin(null)).toBeNull();
  });
});

describe("本番デプロイ起動の可否（canTriggerDeploy・#2020）", () => {
  const MERGED_AT = "2026-08-15T10:00:00Z";
  const NOW = new Date("2026-08-15T10:01:00Z").getTime();

  const RELEASED = [
    pullRequest({
      number: 1573,
      title: "v3.22.0をmainへリリースする",
      baseRef: "main",
      headRef: "develop",
      kind: "release",
      linkedIssueNumber: null,
      state: "closed",
      merged: true,
      mergedAt: MERGED_AT,
    }),
  ];

  function buildDeploy(input: {
    hasDeployWorkflow?: boolean;
    deployRun?: Partial<BranchFlowDeployRun> | null;
    aheadBy?: number;
  }) {
    const deployStatuses: RepositoryDeployStatus[] | undefined =
      input.deployRun === null
        ? undefined
        : [
            {
              repositoryFullName: REPO,
              failureIssue: null,
              deployRun: {
                status: "completed",
                conclusion: "success",
                htmlUrl: `https://github.com/${REPO}/actions/runs/1`,
                createdAt: "2026-08-15T10:00:30Z",
                event: "push",
                runAttempt: 1,
                ...input.deployRun,
              },
            },
          ];
    return build({
      pullRequests: RELEASED,
      branchStatuses: [
        branchStatus({
          developVsMain: { aheadBy: input.aheadBy ?? 0, behindBy: 0 },
          hasDeployWorkflow: input.hasDeployWorkflow ?? true,
        }),
      ],
      deployStatuses,
      now: NOW,
    }).repositories[0];
  }

  it("deploy.ymlがあり、デプロイが動いていなければ押せる", () => {
    expect(buildDeploy({}).canTriggerDeploy).toBe(true);
  });

  it("未リリースの変更があっても押せる（mainをそのまま出し直す操作のため）", () => {
    expect(buildDeploy({ aheadBy: 5 }).canTriggerDeploy).toBe(true);
  });

  it("deploy.ymlを持たないリポジトリでは押せない", () => {
    expect(buildDeploy({ hasDeployWorkflow: false }).canTriggerDeploy).toBe(false);
  });

  it("デプロイが動いている間は押せない（重ねて起動すると走っている実行を打ち切るため）", () => {
    const repository = buildDeploy({ deployRun: { status: "in_progress", conclusion: null } });
    expect(repository.summary.deploy?.kind).toBe("running");
    expect(repository.canTriggerDeploy).toBe(false);
  });

  it("マージ済みだが実行がまだ現れていない間も押せない", () => {
    // マージより前の実行しか無い＝今回ぶんの実行を待っている状態（`waiting`）
    const repository = buildDeploy({ deployRun: { createdAt: "2026-08-15T09:00:00Z" } });
    expect(repository.summary.deploy?.kind).toBe("waiting");
    expect(repository.canTriggerDeploy).toBe(false);
  });

  // 計画レビューの指摘1（#2020）。出し直しの実行を版の判定へそのまま流すと、すでに本番へ
  // 出ている版が「まだ出ていない」ように読める
  it("手動の出し直しは版の状態を取り消さない（manualの印を付けて渡す）", () => {
    const running = buildDeploy({
      deployRun: { status: "in_progress", conclusion: null, event: "workflow_dispatch" },
    });
    expect(running.summary.deploy).toMatchObject({ kind: "running", manual: true });

    const failed = buildDeploy({
      deployRun: { conclusion: "failure", event: "workflow_dispatch" },
    });
    expect(failed.summary.deploy).toMatchObject({ kind: "failure", manual: true });

    // mainへのpushで走った実行は従来どおり（版が本番へ出たかを表す）
    expect(buildDeploy({ deployRun: { status: "in_progress", conclusion: null } }).summary.deploy)
      .toMatchObject({ kind: "running", manual: false });
  });

  // #2134。自動再実行は同じrunのattemptを増やすだけなので、`createdAt`も`event`も初回のまま
  // 変わらない。再実行されたことを言える材料は`runAttempt`しかない
  it("自動再実行された実行にはautoRetriedの印を付ける", () => {
    const running = buildDeploy({
      deployRun: { status: "in_progress", conclusion: null, runAttempt: 2 },
    });
    expect(running.summary.deploy).toMatchObject({ kind: "running", autoRetried: true });

    const failed = buildDeploy({ deployRun: { conclusion: "failure", runAttempt: 2 } });
    expect(failed.summary.deploy).toMatchObject({ kind: "failure", autoRetried: true });

    // 初回の試行には付けない
    expect(
      buildDeploy({ deployRun: { status: "in_progress", conclusion: null } }).summary.deploy,
    ).toMatchObject({ kind: "running", autoRetried: false });
  });

  // まだ現れていない実行に試行回数は無い（印を付けると「再実行を待っている」ように読める）
  it("デプロイ待ちにはautoRetriedを付けない", () => {
    const repository = buildDeploy({
      deployRun: { createdAt: "2026-08-15T09:00:00Z", runAttempt: 2 },
    });
    expect(repository.summary.deploy).toMatchObject({ kind: "waiting", autoRetried: false });
  });

  // 出し直しの実行はマージ時刻との比較に掛けない（掛けると「デプロイ待ち」に化ける）
  it("マージより前に始まった出し直しでも「デプロイ待ち」にしない", () => {
    const repository = buildDeploy({
      deployRun: { createdAt: "2026-08-15T09:00:00Z", event: "workflow_dispatch" },
    });
    expect(repository.summary.deploy).toMatchObject({ kind: "success", manual: true });
  });

  it("デプロイに失敗した後は押せる（出し直せることが要る）", () => {
    const repository = buildDeploy({ deployRun: { conclusion: "failure" } });
    expect(repository.summary.deploy?.kind).toBe("failure");
    expect(repository.canTriggerDeploy).toBe(true);
  });

  it("デプロイ状況を取得できていなくても押せる（判定材料が無いだけで、起動は妨げない）", () => {
    expect(buildDeploy({ deployRun: null }).canTriggerDeploy).toBe(true);
  });
});

describe("リリース起動の可否（canTriggerRelease）", () => {
  const repositories = [{ fullName: REPO, private: false }];

  function buildRelease(input: {
    pullRequests?: PullRequestSummary[];
    aheadBy?: number;
    hasReleaseWorkflow?: boolean;
    /** ブランチ状況そのものが取得できていない場合 */
    branchStatusMissing?: boolean;
  }) {
    return buildBranchFlow({
      repositories,
      pullRequests: input.pullRequests ?? [],
      issues: [],
      branchStatuses: input.branchStatusMissing
        ? []
        : [
            branchStatus({
              developVsMain: { aheadBy: input.aheadBy ?? 3, behindBy: 0 },
              hasReleaseWorkflow: input.hasReleaseWorkflow ?? true,
            }),
          ],
    }).repositories[0];
  }

  it("未リリースの変更があり、リリースPRもバンプPRも無ければ押せる", () => {
    expect(buildRelease({}).canTriggerRelease).toBe(true);
  });

  it("リリース用workflowを持たないリポジトリでは押せない（#1538）", () => {
    const repository = buildRelease({ hasReleaseWorkflow: false });
    expect(repository.canRelease).toBe(false);
    expect(repository.canTriggerRelease).toBe(false);
  });

  it("ブランチ状況を取得できていなければ押せない", () => {
    expect(buildRelease({ branchStatusMissing: true }).canTriggerRelease).toBe(false);
  });

  it("未リリースの変更が無ければ押せない", () => {
    expect(buildRelease({ aheadBy: 0 }).canTriggerRelease).toBe(false);
  });

  it("openなリリースPRがあれば押せない", () => {
    const repository = buildRelease({
      pullRequests: [
        releasePullRequest({ number: 183, title: "v3.8.6をmainへリリースする", state: "open" }),
      ],
    });
    expect(repository.canTriggerRelease).toBe(false);
  });

  it("openなバンプPRがあれば押せない（起こし直すと二重に走る）", () => {
    const repository = buildRelease({
      pullRequests: [
        pullRequest({
          number: 182,
          headRef: "release/v3.8.6",
          kind: "version-bump",
          linkedIssueNumber: null,
          state: "open",
        }),
      ],
    });
    expect(repository.canTriggerRelease).toBe(false);
  });
});

describe("バージョンバンプPRの扱い（#1548）", () => {
  const openBump = pullRequest({
    number: 1547,
    title: "v3.21.0をリリースする",
    headRef: "release/v3.21.0",
    kind: "version-bump",
    // バンプPR本文には今回のリリース対象issueが並ぶため、参照Issueが付く
    linkedIssueNumber: 1503,
    linkedIssueNumbers: [1503, 1527, 1528],
    state: "open",
    autoMergeEnabled: true,
    ciState: "pending",
  });

  const flow = build({
    pullRequests: [
      openBump,
      pullRequest({ number: 1545, headRef: "issue-1541", linkedIssueNumber: 1541, state: "open" }),
    ],
    issues: [issue({ number: 1541, projectStatus: "Develop PR" })],
    branchStatuses: [branchStatus({ developVsMain: { aheadBy: 16, behindBy: 0 } })],
  });
  const [repository] = flow.repositories;

  it("作業レーンには現れない（無関係なIssueがぶら下がるのを防ぐ）", () => {
    expect(allLanes(repository).map((lane) => lane.branchName)).not.toContain("release/v3.21.0");
  });

  it("未リリースの束が幹の一部として持つ", () => {
    expect(repository.releaseGroups[0].bumpPullRequest?.number).toBe(1547);
  });

  it("束の版はバンプPRのブランチ名から決まる", () => {
    expect(repository.releaseGroups[0].version).toBe("3.21.0");
  });

  it("リリース進行中として畳んだ行に出す", () => {
    expect(repository.summary.releaseInProgress).toBe(true);
  });

  // 畳んだ1行の「リリース中」を回してよいかの判定（#1931）。CIが終わっていれば、
  // 待つのではなく人がマージする番なので回さない。
  it("CI実行中のバンプPRはリリースのCI実行中として拾う", () => {
    expect(repository.summary.releaseCiPending).toBe(true);
  });

  it("CIが終わったバンプPRはリリースのCI実行中にしない", () => {
    const done = build({
      pullRequests: [pullRequest({ ...openBump, ciState: "success" })],
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 16, behindBy: 0 } })],
    }).repositories[0];
    expect(done.summary.releaseCiPending).toBe(false);
  });

  it("CIが落ちたバンプPRはCI失敗として拾う", () => {
    const failing = build({
      pullRequests: [pullRequest({ ...openBump, ciState: "failure" })],
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 16, behindBy: 0 } })],
    }).repositories[0];
    expect(failing.summary.hasCiFailure).toBe(true);
  });

  it("マージ済みのバンプPRはどこにも出さない（版の見出しが表すため）", () => {
    const merged = build({
      pullRequests: [
        pullRequest({
          number: 1547,
          headRef: "release/v3.21.0",
          kind: "version-bump",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-15T01:00:00Z",
        }),
      ],
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 16, behindBy: 0 } })],
    }).repositories[0];

    expect(allLanes(merged).map((lane) => lane.branchName)).toEqual([]);
    expect(merged.releaseGroups[0].bumpPullRequest).toBeNull();
  });
});

describe("本番デプロイの状態（#1579）", () => {
  const MERGED_AT = "2026-08-15T10:00:00Z";
  const JUST_AFTER_MERGE = new Date("2026-08-15T10:01:00Z").getTime();

  /** mainへ入ったリリースPRと、その版に乗った作業レーン1本 */
  const RELEASED = [
    pullRequest({
      number: 1573,
      title: "v3.22.0をmainへリリースする",
      baseRef: "main",
      headRef: "develop",
      kind: "release",
      linkedIssueNumber: null,
      state: "closed",
      merged: true,
      mergedAt: MERGED_AT,
    }),
    pullRequest({
      number: 1570,
      headRef: "issue-1524",
      linkedIssueNumber: 1524,
      state: "closed",
      merged: true,
      mergedAt: "2026-08-15T09:00:00Z",
    }),
  ];

  function deployRun(overrides: Partial<BranchFlowDeployRun> = {}): RepositoryDeployStatus[] {
    return [
      {
        repositoryFullName: REPO,
        failureIssue: null,
        deployRun: {
          status: "completed",
          conclusion: "success",
          htmlUrl: `https://github.com/${REPO}/actions/runs/1`,
          // 既定は「マージの後に始まった実行」
          createdAt: "2026-08-15T10:00:30Z",
          event: "push",
          runAttempt: 1,
          ...overrides,
        },
      },
    ];
  }

  function releasedGroup(deployStatuses?: RepositoryDeployStatus[], now = JUST_AFTER_MERGE) {
    const [repository] = build({
      pullRequests: RELEASED,
      branchStatuses: [branchStatus()],
      deployStatuses,
      now,
    }).repositories;
    return repository;
  }

  it("マージ後に始まった実行が終わっていなければ「実行中」", () => {
    const repository = releasedGroup(deployRun({ status: "in_progress", conclusion: null }));
    expect(repository.releaseGroups[0].deploy).toEqual({
      kind: "running",
      manual: false,
      autoRetried: false,
      htmlUrl: `https://github.com/${REPO}/actions/runs/1`,
    });
    // 畳んだ1行にも同じ状態を出す
    expect(repository.summary.deploy?.kind).toBe("running");
  });

  it("成功していれば「成功」（ここで初めて本番反映と言ってよい）", () => {
    expect(releasedGroup(deployRun()).releaseGroups[0].deploy?.kind).toBe("success");
  });

  it("失敗・キャンセルは「失敗」（mainには入ったが本番には出ていない）", () => {
    expect(releasedGroup(deployRun({ conclusion: "failure" })).releaseGroups[0].deploy?.kind).toBe(
      "failure",
    );
    expect(releasedGroup(deployRun({ conclusion: "cancelled" })).releaseGroups[0].deploy?.kind).toBe(
      "failure",
    );
  });

  it("最新の実行がマージより古ければ「デプロイ待ち」（実行がまだ現れていない）", () => {
    const repository = releasedGroup(deployRun({ createdAt: "2026-08-14T00:00:00Z" }));
    expect(repository.releaseGroups[0].deploy).toEqual({
      kind: "waiting",
      htmlUrl: null,
      manual: false,
      autoRetried: false,
    });
  });

  it("待っても実行が現れないまま15分を過ぎたら、状態を出すのをやめる", () => {
    // mainへのpushでデプロイしないリポジトリで、永久に「待ち」と言い続けないため
    const repository = releasedGroup(
      deployRun({ createdAt: "2026-08-14T00:00:00Z" }),
      new Date("2026-08-15T10:16:00Z").getTime(),
    );
    expect(repository.releaseGroups[0].deploy).toBeNull();
  });

  it("実行を取得できていなければ状態を出さない（従来どおりの表示に戻す）", () => {
    const repository = releasedGroup(undefined);
    expect(repository.releaseGroups[0].deploy).toBeNull();
    expect(repository.summary.deploy).toBeNull();
  });

  it("状態が乗るのはいちばん新しい版の束だけ（前の版のデプロイ結果は分からない）", () => {
    const [repository] = build({
      pullRequests: [
        ...RELEASED,
        pullRequest({
          number: 1400,
          title: "v3.21.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
        pullRequest({
          number: 1390,
          headRef: "issue-1380",
          linkedIssueNumber: 1380,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-09T00:00:00Z",
        }),
      ],
      branchStatuses: [branchStatus()],
      deployStatuses: deployRun({ status: "in_progress", conclusion: null }),
      now: JUST_AFTER_MERGE,
    }).repositories;

    const [latest, previous] = repository.releaseGroups;
    expect(latest.version).toBe("3.22.0");
    expect(latest.deploy?.kind).toBe("running");
    expect(previous.version).toBe("3.21.0");
    expect(previous.deploy).toBeNull();
  });

  it("直近のリリースのマージ時刻をリポジトリごとに取り出せる（ポーリングの要否判定に使う）", () => {
    const merged = latestReleaseMergedAtByRepository([
      ...RELEASED,
      pullRequest({
        number: 1400,
        title: "v3.21.0をmainへリリースする",
        baseRef: "main",
        headRef: "develop",
        kind: "release",
        linkedIssueNumber: null,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-10T00:00:00Z",
      }),
      // openなリリースPRはまだmainへ入っていないので数えない
      pullRequest({
        number: 1600,
        baseRef: "main",
        headRef: "develop",
        kind: "release",
        linkedIssueNumber: null,
        state: "open",
      }),
    ]);

    expect(merged.get(REPO)).toBe(MERGED_AT);
  });

  it("まだmainへ入っていない束には状態を出さない", () => {
    const [repository] = build({
      pullRequests: [
        pullRequest({
          number: 1600,
          title: "v3.23.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "open",
        }),
      ],
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      deployStatuses: deployRun(),
      now: JUST_AFTER_MERGE,
    }).repositories;

    expect(repository.releaseGroups[0].mergedAt).toBeNull();
    expect(repository.releaseGroups[0].deploy).toBeNull();
  });
});

describe("サマリー行の集計", () => {
  it("CI失敗とユーザーのマージ待ちを拾う", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ number: 1, headRef: "issue-1", linkedIssueNumber: 1, ciState: "failure" }),
        pullRequest({
          number: 2,
          headRef: "issue-2",
          linkedIssueNumber: 2,
          linkedIssueCheckUser: true,
          linkedIssueCheckReason: "merge",
        }),
      ],
      branchStatuses: [branchStatus()],
    });

    expect(flow.repositories[0].summary).toEqual({
      activeLaneCount: 2,
      hasCiFailure: true,
      needsUserMerge: true,
      openManualStepCount: 0,
      plannedIssueCount: 0,
      releaseInProgress: false,
      releaseCiPending: false,
      releaseMergeTarget: null,
      deploy: null,
    });
  });

  it("未完了の手作業を数える。同じIssueが複数レーンにあっても1件（#1586）", () => {
    const manualStepBody = ["## 関連", "", "- 起点Issue #137"].join("\n");
    const flow = build({
      issues: [
        issue({ number: 137, title: "利用規約を整理" }),
        issue({
          number: 184,
          title: "[手作業] VPS: リダイレクトを外す",
          projectStatus: "Ready",
          labels: ["71.manual-step"],
          body: manualStepBody,
        }),
        issue({
          number: 185,
          title: "[手作業] VPS: 旧設定を消す",
          projectStatus: "Ready",
          state: "closed",
          labels: ["71.manual-step"],
          body: manualStepBody,
        }),
      ],
      // 同じIssueを2本のブランチで扱っている＝手作業も2レーンにぶら下がる
      pullRequests: [
        pullRequest({ number: 181, headRef: "issue-137", linkedIssueNumber: 137 }),
        pullRequest({ number: 182, headRef: "fix/137-followup", linkedIssueNumber: 137 }),
      ],
      branchStatuses: [branchStatus()],
    });

    // openの#184だけを、レーンの本数によらず1件として数える
    expect(flow.repositories[0].summary.openManualStepCount).toBe(1);
  });

  it("マージ済みのPRのCI失敗は数えない（もう手を動かす対象ではない）", () => {
    const flow = build({
      pullRequests: [
        pullRequest({
          number: 1,
          headRef: "issue-1",
          linkedIssueNumber: 1,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
          ciState: "failure",
        }),
      ],
      branchStatuses: [branchStatus()],
    });
    expect(flow.repositories[0].summary.hasCiFailure).toBe(false);
  });
});

// #1704: まだブランチが無い「実装予定」のIssueも画面に出す
/**
 * リリースが自動で進んでいるのか、人が押す番なのかの判定（#2038）。
 * 畳んだ1行が紫の「リリース中」を出すか、琥珀の「mainへマージ待ち」を出すかがここで決まる。
 */
describe("リリースのマージ待ち（releaseMergeTarget）", () => {
  function summaryOf(pullRequests: PullRequestSummary[]) {
    return build({
      pullRequests,
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
    }).repositories[0].summary;
  }

  const releasePullRequest = (overrides: Partial<PullRequestSummary> = {}) =>
    pullRequest({
      number: 1600,
      title: "v3.23.0をmainへリリースする",
      headRef: "develop",
      baseRef: "main",
      kind: "release",
      linkedIssueNumber: null,
      state: "open",
      ...overrides,
    });

  const bumpPullRequest = (overrides: Partial<PullRequestSummary> = {}) =>
    pullRequest({
      number: 1599,
      title: "v3.23.0をリリースする",
      headRef: "release/v3.23.0",
      kind: "version-bump",
      linkedIssueNumber: null,
      state: "open",
      autoMergeEnabled: true,
      ...overrides,
    });

  it("CIが終わったリリースPRはmainへのマージ待ち", () => {
    expect(summaryOf([releasePullRequest({ ciState: "success" })]).releaseMergeTarget).toBe("main");
  });

  it("CI実行中は待ちにしない（まだマージできない操作を促さない）", () => {
    expect(summaryOf([releasePullRequest({ ciState: "pending" })]).releaseMergeTarget).toBeNull();
  });

  // 赤の「CI失敗」と琥珀の「マージ待ち」が同じ行に並ぶと、直すのかマージするのかを取り違える（#1059）
  it("CIが落ちているあいだは待ちにしない（CI失敗のバッジに任せる）", () => {
    const summary = summaryOf([releasePullRequest({ ciState: "failure" })]);
    expect(summary.releaseMergeTarget).toBeNull();
    expect(summary.hasCiFailure).toBe(true);
  });

  // CI状態が取れないだけで、待っているものが画面から消える方が困る
  it("CI状態が分からない（unknown）ときは待ちのまま残す", () => {
    expect(summaryOf([releasePullRequest({ ciState: "unknown" })]).releaseMergeTarget).toBe("main");
  });

  it("Auto-mergeが効いているバンプPRは待ちにしない（放っておけばdevelopへ入る）", () => {
    expect(summaryOf([bumpPullRequest({ ciState: "success" })]).releaseMergeTarget).toBeNull();
  });

  it("Auto-mergeが効かず滞留しているバンプPRはdevelopへのマージ待ち", () => {
    const summary = summaryOf([bumpPullRequest({ autoMergeEnabled: false, ciState: "success" })]);
    expect(summary.releaseMergeTarget).toBe("develop");
  });

  it("リリースPRとバンプPRが両方あればmainを優先する（先に押すのはmain側）", () => {
    const summary = summaryOf([
      releasePullRequest({ ciState: "success" }),
      bumpPullRequest({ autoMergeEnabled: false, ciState: "success" }),
    ]);
    expect(summary.releaseMergeTarget).toBe("main");
  });

  it("リリースが動いていなければnull", () => {
    expect(summaryOf([]).releaseMergeTarget).toBeNull();
  });
});

describe("実装予定のIssue（plannedIssues）", () => {
  it("未着手・計画検討中のopen Issueを集め、件数をサマリーへ出す", () => {
    const flow = build({
      issues: [
        issue({ number: 10, title: "未着手のもの", projectStatus: "Ready" }),
        issue({ number: 11, title: "計画検討中のもの", projectStatus: "Planning" }),
      ],
      branchStatuses: [branchStatus()],
    });

    const [repository] = flow.repositories;
    expect(repository.plannedIssues.map((planned) => planned.number)).toEqual([11, 10]);
    expect(repository.plannedIssues[0]).toMatchObject({
      number: 11,
      title: "計画検討中のもの",
      progress: "planning",
      priority: null,
    });
    expect(repository.summary.plannedIssueCount).toBe(2);
  });

  it("実装中以降・クローズ済み・手作業Issueは実装予定に入れない", () => {
    const flow = build({
      issues: [
        issue({ number: 20, projectStatus: "Implementation" }),
        issue({ number: 21, projectStatus: "Develop" }),
        issue({ number: 22, projectStatus: "Ready", state: "closed" }),
        issue({ number: 23, projectStatus: "Ready", labels: ["71.manual-step"] }),
      ],
      branchStatuses: [branchStatus()],
    });

    expect(flow.repositories[0].plannedIssues).toEqual([]);
    expect(flow.repositories[0].summary.plannedIssueCount).toBe(0);
  });

  it("すでにレーンとして出ているIssueは、実装予定へ重ねて出さない", () => {
    const flow = build({
      issues: [issue({ number: 30, projectStatus: "Ready" })],
      pullRequests: [pullRequest({ number: 1, headRef: "issue-30", linkedIssueNumber: 30 })],
      branchStatuses: [branchStatus()],
    });

    expect(allLanes(flow.repositories[0])).toHaveLength(1);
    expect(flow.repositories[0].plannedIssues).toEqual([]);
  });

  it("計画検討中 → 優先度の高い順 → 番号の新しい順で並べる", () => {
    const flow = build({
      issues: [
        issue({ number: 40, projectStatus: "Ready" }),
        issue({ number: 41, projectStatus: "Ready", labels: ["89.Priority: low"] }),
        issue({ number: 42, projectStatus: "Ready", labels: ["80.Priority: High"] }),
        issue({ number: 43, projectStatus: "Ready" }),
        issue({ number: 44, projectStatus: "Planning" }),
      ],
      branchStatuses: [branchStatus()],
    });

    expect(flow.repositories[0].plannedIssues.map((planned) => planned.number)).toEqual([
      44, 42, 43, 40, 41,
    ]);
    expect(flow.repositories[0].plannedIssues[1].priority).toBe("high");
    expect(flow.repositories[0].plannedIssues.at(-1)?.priority).toBe("low");
  });
});

// #1750: ブランチ画面はリポジトリ絞り込みを適用せず、選択中を先頭へ寄せて展開する
describe("orderRepositoriesBySelection", () => {
  const repositories = [
    { fullName: "owner/a" },
    { fullName: "owner/b" },
    { fullName: "owner/c" },
  ];

  it("選択中のリポジトリを先頭へ寄せ、どちらのグループも元の並びを保つ", () => {
    expect(orderRepositoriesBySelection(repositories, ["owner/c", "owner/b"])).toEqual([
      { fullName: "owner/b" },
      { fullName: "owner/c" },
      { fullName: "owner/a" },
    ]);
  });

  it("選択が無ければ並びは変わらない", () => {
    expect(orderRepositoriesBySelection(repositories, [])).toEqual(repositories);
  });

  it("選択されていても一覧に無いリポジトリは足さない（＝件数は増えない）", () => {
    expect(orderRepositoriesBySelection(repositories, ["owner/unknown"])).toEqual(repositories);
  });
});
