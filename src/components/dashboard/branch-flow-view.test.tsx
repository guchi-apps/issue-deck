// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { buildBranchFlow, type BranchFlowIssueSource } from "@/lib/branch-flow";
import type { RepositoryBranchStatus } from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

const REPO = "guchi-apps/issue-deck";
/** サマリー行に出るリポジトリ名（`owner/`は落とす） */
const REPO_SHORT = "issue-deck";

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
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

/** develop→mainのリリースPR */
function makeReleasePullRequest(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return makePullRequest({
    baseRef: "main",
    headRef: "develop",
    kind: "release",
    linkedIssueNumber: null,
    ...overrides,
  });
}

function renderFlow(input: {
  pullRequests?: PullRequestSummary[];
  issues?: BranchFlowIssueSource[];
  branchStatuses?: RepositoryBranchStatus[];
  failedRepositories?: string[];
  hasClaudeWorkflow?: boolean;
  onRefresh?: () => void;
}) {
  const flow = buildBranchFlow({
    repositories: [
      { fullName: REPO, private: false, hasClaudeWorkflow: input.hasClaudeWorkflow ?? false },
    ],
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
      failedRepositories={input.failedRepositories ?? []}
      onRefresh={input.onRefresh ?? vi.fn()}
    />,
  );
}

/** 既定では畳まれているため、中身を見るテストは先に開く */
function openRepository() {
  fireEvent.click(screen.getByText(REPO_SHORT));
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

describe("BranchFlowView", () => {
  afterEach(() => cleanup());

  describe("畳む・開く", () => {
    it("既定ではリポジトリを1行に畳み、中身は出さない", () => {
      renderFlow({
        pullRequests: [makePullRequest({ number: 1461, headRef: "issue-1454" })],
        branchStatuses: [
          branchStatus({
            checkedBranches: ["issue-1454"],
            existingBranches: ["issue-1454"],
          }),
        ],
      });

      expect(screen.getByText(REPO_SHORT)).toBeTruthy();
      expect(screen.getByText("進行中1")).toBeTruthy();
      expect(screen.queryByText("issue-1454")).toBeNull();
    });

    it("クリックで開き、もう一度クリックで閉じる", () => {
      renderFlow({
        pullRequests: [makePullRequest({ number: 1461, headRef: "issue-1454" })],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      openRepository();
      expect(screen.getByText("issue-1454")).toBeTruthy();
      openRepository();
      expect(screen.queryByText("issue-1454")).toBeNull();
    });

    it("CIが失敗しているリポジトリは最初から開いておく", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({ number: 1461, headRef: "issue-1454", ciState: "failure" }),
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      // サマリー行のピルと、開いた先のPR行のCI状態の両方に出る
      expect(screen.getAllByText("CI失敗").length).toBeGreaterThan(0);
      expect(screen.getByText("issue-1454")).toBeTruthy();
      expect(screen.getByText(/手が要るもの1件/)).toBeTruthy();
    });

    it("ユーザーのマージを待っているリポジトリも最初から開く", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({
            number: 1461,
            headRef: "issue-1454",
            linkedIssueCheckUser: true,
            linkedIssueCheckReason: "merge",
          }),
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      expect(screen.getByText("ユーザーのマージが必要")).toBeTruthy();
      expect(screen.getByText("issue-1454")).toBeTruthy();
    });

    it("動きの無いリポジトリも1行で並べる", () => {
      renderFlow({ branchStatuses: [branchStatus()] });
      expect(screen.getByText(REPO_SHORT)).toBeTruthy();
      expect(screen.getByText("動きなし")).toBeTruthy();
    });

    it("ブランチ状況を取得できなかったことはサマリー行に出す", () => {
      renderFlow({ failedRepositories: [REPO] });
      expect(screen.getByText("ブランチ状況を取得できず")).toBeTruthy();
    });

    it("「すべて開く」で全リポジトリを開く", () => {
      renderFlow({
        pullRequests: [makePullRequest({ number: 1461, headRef: "issue-1454" })],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      expect(screen.queryByText("issue-1454")).toBeNull();
      fireEvent.click(screen.getByText("すべて開く"));
      expect(screen.getByText("issue-1454")).toBeTruthy();
      fireEvent.click(screen.getByText("すべて閉じる"));
      expect(screen.queryByText("issue-1454")).toBeNull();
    });
  });

  describe("流れ図", () => {
    it("Issue・ブランチ・PRを1本のレーンとして並べる", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({ number: 1461, headRef: "issue-1454", linkedIssueNumber: 1454 }),
        ],
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
          branchStatus({
            checkedBranches: ["issue-1454"],
            existingBranches: ["issue-1454"],
            developVsMain: { aheadBy: 12, behindBy: 0 },
          }),
        ],
      });

      openRepository();
      expect(screen.getByText("issue-1454")).toBeTruthy();
      expect(screen.getByText("#1461 PRのタイトル")).toBeTruthy();
      expect(screen.getByText(/Issue #1454/)).toBeTruthy();
      expect(screen.getByText("実装中")).toBeTruthy();
      expect(screen.getByText("未リリース 12コミット")).toBeTruthy();
    });

    it("mainにしか無いコミット数は出さない（リリースのマージコミットで必ず増えるだけのため）", () => {
      renderFlow({
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 0, behindBy: 26 } })],
      });

      openRepository();
      expect(screen.queryByText(/未取り込み/)).toBeNull();
    });

    it("PRが無いブランチは「PR未作成」として出す", () => {
      renderFlow({
        branchStatuses: [
          branchStatus({
            checkedBranches: ["develop", "issue-1455"],
            existingBranches: ["develop", "issue-1455"],
          }),
        ],
      });

      openRepository();
      expect(screen.getByText("PR未作成")).toBeTruthy();
      expect(screen.getByText("issue-1455")).toBeTruthy();
    });

    it("マージ済みのレーンには状態のピルを出さず、バージョンの束で表す", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1452,
            title: "v3.17.0をmainへリリースする",
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
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 0, behindBy: 0 } })],
      });

      openRepository();
      // v3.17.0の束の中に並ぶ。トグルを押さなくても見える
      expect(screen.getByText("issue-1456")).toBeTruthy();
      // 畳んだ行の現在の版と、束の見出しの両方に出る
      expect(screen.getAllByText("v3.17.0")).toHaveLength(2);
      expect(screen.getByText("このバージョンに乗った変更 1件")).toBeTruthy();
      // 旧表示のピルはもう出さない
      expect(screen.queryByText("developへマージ済み")).toBeNull();
      expect(screen.queryByText("v3.17.0で本番反映")).toBeNull();
    });

    it("本番未反映の束は「リリース中」または「本番未反映」として先頭に出す", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1452,
            title: "v3.17.0をmainへリリースする",
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
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });

      openRepository();
      expect(screen.getByText("本番未反映")).toBeTruthy();
      expect(screen.getByText("issue-1456")).toBeTruthy();
      expect(screen.getByText("このバージョンに乗る変更 1件")).toBeTruthy();
    });

    it("既定はひとつ前の版まで出し、それ以前はボタンで開く", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 900,
            title: "v3.15.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-01T00:00:00Z",
          }),
          makeReleasePullRequest({
            number: 910,
            title: "v3.16.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-05T00:00:00Z",
          }),
          makeReleasePullRequest({
            number: 920,
            title: "v3.17.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-10T00:00:00Z",
          }),
          makePullRequest({
            number: 800,
            headRef: "issue-800",
            state: "closed",
            merged: true,
            mergedAt: "2026-07-31T00:00:00Z",
          }),
          makePullRequest({
            number: 905,
            headRef: "issue-905",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-03T00:00:00Z",
          }),
          makePullRequest({
            number: 915,
            headRef: "issue-915",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-08T00:00:00Z",
          }),
        ],
        branchStatuses: [branchStatus()],
      });

      openRepository();
      expect(screen.getByText("issue-915")).toBeTruthy();
      expect(screen.getByText("issue-905")).toBeTruthy();
      expect(screen.queryByText("issue-800")).toBeNull();

      fireEvent.click(screen.getByText("さらに前のバージョンを表示（1件）"));
      expect(screen.getByText("issue-800")).toBeTruthy();
    });

    it("PRと同じ題のIssueはタイトルを繰り返さない", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({
            number: 1461,
            title: "リリースタグの重複を検査する",
            headRef: "issue-1454",
            linkedIssueNumber: 1454,
          }),
        ],
        issues: [
          {
            number: 1454,
            title: "リリースタグの重複を検査する",
            repositoryFullName: REPO,
            state: "open",
            projectStatus: "Implementation",
          },
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      openRepository();
      expect(screen.getByText("Issue #1454")).toBeTruthy();
      expect(screen.getByText("（PRと同じ題）")).toBeTruthy();
    });

    it("タイトルを出せない関連Issueは番号だけを1行に並べる", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({
            number: 1461,
            headRef: "issue-1454",
            linkedIssueNumber: 1454,
            linkedIssueNumbers: [1454, 55, 1459],
          }),
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      openRepository();
      expect(screen.getByText("関連")).toBeTruthy();
      expect(screen.getByText("#55")).toBeTruthy();
      expect(screen.getByText("#1459")).toBeTruthy();
      expect(screen.queryByText("一覧に無いIssue")).toBeNull();
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
        branchStatuses: [branchStatus()],
      });

      openRepository();
      expect(screen.getByText("ブランチもPRも見つからないIssue")).toBeTruthy();
      expect(screen.getByText(/Issue #1450/)).toBeTruthy();
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
          branchStatus({ checkedBranches: ["issue-1455"], existingBranches: ["issue-1455"] }),
        ],
      });

      openRepository();
      expect(screen.getByText("issue-1455")).toBeTruthy();
      expect(screen.getByText("fix/1455-followup")).toBeTruthy();
      expect(screen.getAllByText(/Issue #1455/)).toHaveLength(2);
    });

    it("表示できるリポジトリが無いときは空状態を出す", () => {
      const flow = buildBranchFlow({
        repositories: [],
        pullRequests: [],
        issues: [],
        branchStatuses: [],
      });
      render(
        <BranchFlowView
          flow={flow}
          fetchedAt={null}
          isLoading={false}
          error={null}
          failedRepositories={[]}
          onRefresh={vi.fn()}
        />,
      );
      expect(screen.getByText("表示できるリポジトリがありません。")).toBeTruthy();
    });
  });

  describe("手作業Issue", () => {
    const manualStepIssue: BranchFlowIssueSource = {
      number: 184,
      title: "[手作業] VPS: リダイレクトを外す",
      repositoryFullName: REPO,
      state: "open",
      projectStatus: "Ready",
      labels: ["71.manual-step"],
      body: "## 関連\n\n- 起点Issue #1454",
    };

    it("起点Issueのレーンにぶら下げる", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({ number: 1461, headRef: "issue-1454", linkedIssueNumber: 1454 }),
        ],
        issues: [
          {
            number: 1454,
            title: "リダイレクトの整理",
            repositoryFullName: REPO,
            state: "open",
            projectStatus: "Implementation",
          },
          manualStepIssue,
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      openRepository();
      expect(screen.getByText(/手作業 #184/)).toBeTruthy();
      expect(screen.getByText("未完了")).toBeTruthy();
    });

    it("完了した手作業は薄く出す", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({ number: 1461, headRef: "issue-1454", linkedIssueNumber: 1454 }),
        ],
        issues: [{ ...manualStepIssue, state: "closed" }],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      openRepository();
      expect(screen.getByText("完了")).toBeTruthy();
    });
  });

  describe("リリース起動ボタン", () => {
    const unreleased = branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } });

    it("未リリースの変更があり、リリース用workflowを持つときだけ出す", () => {
      renderFlow({ hasClaudeWorkflow: true, branchStatuses: [unreleased] });
      openRepository();
      expect(screen.getByText("リリースする")).toBeTruthy();
    });

    it("リリース用workflowが無ければ出さない", () => {
      renderFlow({ hasClaudeWorkflow: false, branchStatuses: [unreleased] });
      openRepository();
      expect(screen.queryByText("リリースする")).toBeNull();
    });

    it("未リリースの変更が無ければ出さない", () => {
      renderFlow({
        hasClaudeWorkflow: true,
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 0, behindBy: 0 } })],
      });
      openRepository();
      expect(screen.queryByText("リリースする")).toBeNull();
    });

    it("リリースPRが動いている間は出さない", () => {
      renderFlow({
        hasClaudeWorkflow: true,
        pullRequests: [
          makeReleasePullRequest({
            number: 183,
            title: "v3.8.6をmainへリリースする",
            state: "open",
          }),
        ],
        branchStatuses: [unreleased],
      });
      openRepository();
      expect(screen.queryByText("リリースする")).toBeNull();
      expect(screen.getByText("リリース中")).toBeTruthy();
    });

    it("押すと今回反映する内容を確認ダイアログに出す", () => {
      renderFlow({
        hasClaudeWorkflow: true,
        pullRequests: [
          makeReleasePullRequest({
            number: 1452,
            title: "v3.17.0をmainへリリースする",
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
        issues: [
          {
            number: 1456,
            title: "本番へ出したい変更",
            repositoryFullName: REPO,
            state: "closed",
            projectStatus: "Develop",
          },
        ],
        branchStatuses: [unreleased],
      });

      openRepository();
      fireEvent.click(screen.getByText("リリースする"));

      expect(screen.getByText("リリースworkflowを起動しますか？")).toBeTruthy();
      expect(screen.getByText("今回反映する内容")).toBeTruthy();
      expect(screen.getByText("#1456 本番へ出したい変更")).toBeTruthy();
    });
  });
});
