// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { buildBranchFlow, type BranchFlowIssueSource } from "@/lib/branch-flow";
import type { RepositoryBranchStatus } from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

const REPO = "guchi-apps/issue-deck";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  const number = overrides.number ?? 1;
  return {
    id: `${REPO}#${number}`,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    number,
    title: "PRのタイトル",
    htmlUrl: `https://github.com/${REPO}/pull/${number}`,
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: `issue-${number}`,
    kind: "issue",
    linkedIssueNumber: number,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function renderFlow(input: {
  pullRequests?: PullRequestSummary[];
  issues?: BranchFlowIssueSource[];
  branchStatuses?: RepositoryBranchStatus[];
}) {
  const flow = buildBranchFlow({
    repositories: [{ fullName: REPO, private: false }],
    pullRequests: input.pullRequests ?? [],
    issues: input.issues ?? [],
    branchStatuses: input.branchStatuses ?? [],
  });

  return render(
    <BranchFlowView
      flow={flow}
      fetchedAt="2026-08-15T10:30:00Z"
      isLoading={false}
      error={null}
      failedRepositories={[]}
      onRefresh={vi.fn()}
    />,
  );
}

describe("BranchFlowView", () => {
  afterEach(() => cleanup());

  it("Issue・ブランチ・PRを1本のレーンとして並べる", () => {
    renderFlow({
      pullRequests: [makePullRequest({ number: 1461, headRef: "issue-1454", linkedIssueNumber: 1454 })],
      issues: [
        {
          number: 1454,
          title: "複数リポジトリ横断質問",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["main", "develop", "issue-1454"],
          existingBranches: ["main", "develop", "issue-1454"],
          developVsMain: { aheadBy: 12, behindBy: 0 },
        },
      ],
    });

    expect(screen.getByText("issue-1454")).toBeTruthy();
    expect(screen.getByText("#1461 PRのタイトル")).toBeTruthy();
    expect(screen.getByText(/Issue #1454/)).toBeTruthy();
    expect(screen.getByText("実装中")).toBeTruthy();
    expect(screen.getByText("未リリース 12コミット")).toBeTruthy();
  });

  it("PRが無いブランチは「PR未作成」として出す", () => {
    renderFlow({
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["develop", "issue-1455"],
          existingBranches: ["develop", "issue-1455"],
          developVsMain: null,
        },
      ],
    });

    expect(screen.getByText("PR未作成")).toBeTruthy();
    expect(screen.getByText("issue-1455")).toBeTruthy();
  });

  it("本番へ出た作業は既定で畳み、トグルで開ける", () => {
    renderFlow({
      pullRequests: [
        makePullRequest({
          number: 1452,
          title: "v3.17.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
        makePullRequest({
          number: 1460,
          headRef: "issue-1456",
          linkedIssueNumber: 1456,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["develop"],
          existingBranches: ["develop"],
          developVsMain: { aheadBy: 1, behindBy: 0 },
        },
      ],
    });

    expect(screen.queryByText("issue-1456")).toBeNull();
    expect(screen.getByText("完了した作業1件は隠しています。")).toBeTruthy();

    fireEvent.click(screen.getByText("完了も表示"));
    expect(screen.getByText("issue-1456")).toBeTruthy();
    expect(screen.getByText("developへマージ済み")).toBeTruthy();
  });

  it("developへ入っただけで本番未反映の作業は、既定で見えている", () => {
    renderFlow({
      pullRequests: [
        makePullRequest({
          number: 1452,
          title: "v3.17.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
        makePullRequest({
          number: 1460,
          headRef: "issue-1456",
          linkedIssueNumber: 1456,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["develop"],
          existingBranches: ["develop"],
          developVsMain: { aheadBy: 3, behindBy: 0 },
        },
      ],
    });

    // トグルを押さずに見える
    expect(screen.getByText("issue-1456")).toBeTruthy();
    expect(screen.getByText("main未反映")).toBeTruthy();
  });

  it("ブランチもPRも無い実装中のIssueを別枠で出す", () => {
    renderFlow({
      issues: [
        {
          number: 1450,
          title: "何も上がっていないIssue",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["main", "develop"],
          existingBranches: ["main", "develop"],
          developVsMain: null,
        },
      ],
    });

    expect(screen.getByText("ブランチもPRも見つからないIssue")).toBeTruthy();
    expect(screen.getByText(/Issue #1450/)).toBeTruthy();
  });

  it("本番へ出た作業は、どのバージョンで反映されたかを出す", () => {
    renderFlow({
      pullRequests: [
        makePullRequest({
          number: 1452,
          title: "v3.17.0をmainへリリースする",
          baseRef: "main",
          headRef: "develop",
          kind: "release",
          linkedIssueNumber: null,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-10T00:00:00Z",
        }),
        makePullRequest({
          number: 1400,
          headRef: "issue-1400",
          linkedIssueNumber: 1400,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["main", "develop"],
          existingBranches: ["main", "develop"],
          developVsMain: { aheadBy: 0, behindBy: 0 },
        },
      ],
    });

    // mainの現在の版はヘッダー側に出る
    expect(screen.getByText("v3.17.0")).toBeTruthy();

    fireEvent.click(screen.getByText("完了も表示"));
    expect(screen.getByText("v3.17.0で本番反映")).toBeTruthy();
  });

  it("1本のPRが複数のIssueを扱う場合、2件目以降を関連Issueとして並べる", () => {
    renderFlow({
      pullRequests: [
        makePullRequest({
          number: 1461,
          headRef: "issue-1454",
          linkedIssueNumber: 1454,
          linkedIssueNumbers: [1454, 1460],
        }),
      ],
      issues: [
        {
          number: 1454,
          title: "主となるIssue",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
        {
          number: 1460,
          title: "一緒に直したIssue",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["issue-1454", "issue-1460"],
          existingBranches: ["issue-1454"],
          developVsMain: null,
        },
      ],
    });

    expect(screen.getByText(/Issue #1454/)).toBeTruthy();
    expect(screen.getByText("関連")).toBeTruthy();
    expect(screen.getByText(/Issue #1460/)).toBeTruthy();
    // 関連として出したIssueを「ブランチもPRも見つからない」側へ重複させない
    expect(screen.queryByText("ブランチもPRも見つからないIssue")).toBeNull();
  });

  it("同じIssueでもブランチが違えばレーンを分けて出す", () => {
    renderFlow({
      pullRequests: [
        makePullRequest({ number: 10, headRef: "issue-1455", linkedIssueNumber: 1455 }),
        makePullRequest({
          number: 11,
          headRef: "fix/1455-followup",
          kind: "other",
          linkedIssueNumber: 1455,
        }),
      ],
      issues: [
        {
          number: 1455,
          title: "可視化する",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
      ],
      branchStatuses: [
        {
          repositoryFullName: REPO,
          checkedBranches: ["issue-1455"],
          existingBranches: ["issue-1455"],
          developVsMain: null,
        },
      ],
    });

    expect(screen.getByText("issue-1455")).toBeTruthy();
    expect(screen.getByText("fix/1455-followup")).toBeTruthy();
    // 同じIssueが両方のレーンに出る
    expect(screen.getAllByText(/Issue #1455/)).toHaveLength(2);
  });

  it("動きのあるリポジトリが無いときは空状態を出す", () => {
    renderFlow({});
    expect(screen.getByText("進行中の作業があるリポジトリはありません。")).toBeTruthy();
  });
});
