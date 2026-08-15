import { describe, expect, it } from "vitest";

import { buildBranchFlow, isCompletedLane, type BranchFlowIssueSource } from "@/lib/branch-flow";
import type { RepositoryBranchStatus } from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

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
    ciState: "success",
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
    ...overrides,
  };
}

const REPOSITORIES = [{ fullName: REPO, private: false }];

function build(input: {
  pullRequests?: PullRequestSummary[];
  issues?: BranchFlowIssueSource[];
  branchStatuses?: RepositoryBranchStatus[];
}) {
  return buildBranchFlow({
    repositories: REPOSITORIES,
    pullRequests: input.pullRequests ?? [],
    issues: input.issues ?? [],
    branchStatuses: input.branchStatuses ?? [],
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
    expect(repository.lanes).toHaveLength(1);
    expect(repository.lanes[0]).toMatchObject({
      branchName: "issue-1455",
      status: "no-pull-request",
      kind: "issue",
    });
    expect(repository.lanes[0].issue).toMatchObject({
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
    expect(left.repositories[0].lanes[0].status).toBe("merged");
  });

  it("ブランチ状況を取得できなかったリポジトリでも、PRだけで組み立てる", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ state: "closed", merged: true, headRef: "issue-1400", linkedIssueNumber: 1400 }),
      ],
      branchStatuses: [],
    });

    expect(flow.repositories[0].branchesLoaded).toBe(false);
    expect(flow.repositories[0].lanes[0].status).toBe("merged");
  });

  it("未マージでクローズされたPRはclosedになる", () => {
    const flow = build({
      pullRequests: [pullRequest({ state: "closed", merged: false })],
      branchStatuses: [branchStatus()],
    });
    expect(flow.repositories[0].lanes[0].status).toBe("closed");
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

    const [lane] = flow.repositories[0].lanes;
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

    const lanes = flow.repositories[0].lanes;
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

    const [lane] = flow.repositories[0].lanes;
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

    expect(flow.repositories[0].lanes[0]).toMatchObject({
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

    expect(flow.repositories[0].lanes[0].issue).toEqual({
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
    expect(repository.lanes).toEqual([]);
  });

  it("バージョンバンプのブランチも規約どおり分類する", () => {
    const flow = build({
      branchStatuses: [branchStatus({ checkedBranches: ["release/v3.18.0"], existingBranches: ["release/v3.18.0"] })],
    });
    expect(flow.repositories[0].lanes[0].kind).toBe("version-bump");
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

    expect(flow.repositories[0].lanes.map((lane) => lane.status)).toEqual([
      "open",
      "no-pull-request",
      "merged",
    ]);
  });

  it("動きの無いリポジトリはカードを出さず、名前だけ返す", () => {
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
        },
      ],
    });

    expect(flow.repositories.map((item) => item.repositoryFullName)).toEqual([REPO]);
    expect(flow.quietRepositories).toEqual(["guchi-apps/quiet"]);
  });

  it("未リリースの変更があるリポジトリはレーンが無くても出す", () => {
    const flow = build({
      branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
    });
    expect(flow.repositories).toHaveLength(1);
    expect(flow.quietRepositories).toEqual([]);
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

    const byBranch = new Map(flow.repositories[0].lanes.map((lane) => [lane.branchName, lane]));
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
    expect(flow.repositories[0].lanes[0].releaseState).toBeNull();
  });

  it("リリースPRを1件も取得できていないときは版を断定しない", () => {
    const flow = build({
      pullRequests: [
        pullRequest({ state: "closed", merged: true, mergedAt: "2026-08-05T00:00:00Z" }),
      ],
      branchStatuses: [branchStatus()],
    });
    expect(flow.repositories[0].lanes[0].releaseState).toEqual({ kind: "unknown" });
    expect(flow.repositories[0].release.latestVersion).toBeNull();
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

    expect(flow.repositories[0].lanes).toEqual([]);
    expect(flow.repositories[0].orphanIssues.map((item) => item.number)).toEqual([1470]);
  });
});

describe("isCompletedLane", () => {
  /** リリース: v3.16.0（08-05）→ 以降にdevelopへ入ったものは本番未反映 */
  const release = pullRequest({
    number: 900,
    title: "v3.16.0をmainへリリースする",
    baseRef: "main",
    headRef: "develop",
    kind: "release",
    linkedIssueNumber: null,
    state: "closed",
    merged: true,
    mergedAt: "2026-08-05T00:00:00Z",
  });

  it("完了として畳むのは、本番へ出たものと未マージでクローズしたものだけ", () => {
    const flow = build({
      pullRequests: [
        release,
        // マージ待ち
        pullRequest({ number: 1, headRef: "issue-1", linkedIssueNumber: 1 }),
        // 本番へ出た（リリース前にdevelopへ入った）
        pullRequest({
          number: 2,
          headRef: "issue-2",
          linkedIssueNumber: 2,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
        // developには入ったが本番未反映
        pullRequest({
          number: 3,
          headRef: "issue-3",
          linkedIssueNumber: 3,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
        // 未マージでクローズ
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

    const lanes = flow.repositories[0].lanes;
    expect(lanes.filter(isCompletedLane).map((lane) => lane.branchName).sort()).toEqual([
      "issue-2",
      "issue-4",
    ]);
    // 本番未反映のものは畳まず、マージ待ちの次に並べる
    expect(lanes.filter((lane) => !isCompletedLane(lane)).map((lane) => lane.branchName)).toEqual([
      "issue-1",
      "issue-3",
    ]);
  });
});
