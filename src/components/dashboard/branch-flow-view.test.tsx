// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { buildBranchFlow, type BranchFlowIssueSource } from "@/lib/branch-flow";
import type { RepositoryBranchStatus, RepositoryDeployStatus } from "@/types/branch-flow";
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
  deployStatuses?: RepositoryDeployStatus[];
  now?: number;
  failedRepositories?: string[];
  onRefresh?: () => void;
}) {
  const flow = buildBranchFlow({
    repositories: [{ fullName: REPO, private: false }],
    pullRequests: input.pullRequests ?? [],
    issues: input.issues ?? [],
    branchStatuses: input.branchStatuses ?? [],
    deployStatuses: input.deployStatuses,
    now: input.now,
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

/**
 * 中身が開いた状態にする。**手が要るリポジトリ（CI失敗・マージ待ち・リリース中）は初回に
 * 自動で開く**ため、そこで`openRepository`を呼ぶと逆に閉じてしまう（#1548）。
 */
function ensureRepositoryOpen() {
  const row = screen.getByText(REPO_SHORT).closest("button");
  if (row?.getAttribute("aria-expanded") !== "true") openRepository();
}

function branchStatus(overrides: Partial<RepositoryBranchStatus> = {}): RepositoryBranchStatus {
  return {
    repositoryFullName: REPO,
    checkedBranches: ["main", "develop"],
    existingBranches: ["main", "develop"],
    developVsMain: null,
    hasReleaseWorkflow: false,
    ...overrides,
  };
}

describe("BranchFlowView", () => {
  afterEach(() => {
    cleanup();
    // リリース起動の二度押し防止は起動時刻をlocalStorageへ置く（#1548）。
    // 消さないと後続のテストが「リリース起動中…」の状態から始まる。
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("畳む・開く", () => {
    it("画面の見出しは「ブランチ」（#1586）", () => {
      renderFlow({});
      expect(screen.getByRole("heading", { name: "ブランチ" })).toBeTruthy();
    });

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
      // リリース済みの束は既定で畳む（#1586）ので、開いてから中身を見る
      fireEvent.click(screen.getByText("リリース済みのバージョンを表示（1件）"));
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

    it("既定は次のリリースの束だけを出し、リリース済みはボタンで開く（#1586）", () => {
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
      // 本番へ出た版はひとつ前（v3.17.0）も含めて畳む
      expect(screen.queryByText("issue-915")).toBeNull();
      expect(screen.queryByText("issue-905")).toBeNull();
      expect(screen.queryByText("issue-800")).toBeNull();

      fireEvent.click(screen.getByText("リリース済みのバージョンを表示（3件）"));
      expect(screen.getByText("issue-915")).toBeTruthy();
      expect(screen.getByText("issue-905")).toBeTruthy();
      expect(screen.getByText("issue-800")).toBeTruthy();
    });

    it("次のリリースに乗る分は畳まずに出す（#1586）", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 920,
            title: "v3.17.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-05T00:00:00Z",
          }),
          // v3.17.0より後にdevelopへ入った＝次のリリースに乗る
          makePullRequest({
            number: 930,
            headRef: "issue-930",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-12T00:00:00Z",
          }),
          // v3.17.0で本番へ出た
          makePullRequest({
            number: 905,
            headRef: "issue-905",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-03T00:00:00Z",
          }),
        ],
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });

      ensureRepositoryOpen();
      expect(screen.getByText("本番未反映")).toBeTruthy();
      expect(screen.getByText("issue-930")).toBeTruthy();
      expect(screen.queryByText("issue-905")).toBeNull();
      expect(screen.getByText("リリース済みのバージョンを表示（1件）")).toBeTruthy();
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

    /**
     * 本番へ出た版のレーンに手作業がぶら下がっている状況（#1586）。
     * 束そのものは畳むが、未完了の手作業だけは別枠で出す。
     */
    function renderReleasedLaneWithManualStep(manualStepState: "open" | "closed") {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 920,
            title: "v3.17.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-10T00:00:00Z",
          }),
          makePullRequest({
            number: 1461,
            headRef: "issue-1454",
            linkedIssueNumber: 1454,
            state: "closed",
            merged: true,
            mergedAt: "2026-08-05T00:00:00Z",
          }),
        ],
        issues: [{ ...manualStepIssue, state: manualStepState }],
        branchStatuses: [branchStatus()],
      });
    }

    it("畳んだリリース済みの束に残る未完了の手作業は別枠で出す（#1586）", () => {
      renderReleasedLaneWithManualStep("open");

      openRepository();
      // 束もレーンも畳まれている（レーンのPRは出ない）
      expect(screen.queryByText(/#1461/)).toBeNull();
      // 手作業だけは別枠に出て、由来のブランチ名が添う
      expect(screen.getByText("リリース済みの変更に残っている手作業")).toBeTruthy();
      expect(screen.getByText(/手作業 #184/)).toBeTruthy();
      expect(screen.getByText("起点")).toBeTruthy();
      expect(screen.getByText("issue-1454")).toBeTruthy();
      // 畳んだ行にも件数を出す
      expect(screen.getByText("手作業1")).toBeTruthy();
    });

    it("完了した手作業は畳んだ束と一緒に隠す（#1586）", () => {
      renderReleasedLaneWithManualStep("closed");

      openRepository();
      expect(screen.queryByText("リリース済みの変更に残っている手作業")).toBeNull();
      expect(screen.queryByText(/手作業 #184/)).toBeNull();
      expect(screen.queryByText("手作業1")).toBeNull();
    });

    it("束を開いたら別枠は出さず、レーンにぶら下げる（#1586）", () => {
      renderReleasedLaneWithManualStep("open");

      openRepository();
      fireEvent.click(screen.getByText("リリース済みのバージョンを表示（1件）"));
      expect(screen.queryByText("リリース済みの変更に残っている手作業")).toBeNull();
      expect(screen.getByText("issue-1454")).toBeTruthy();
      expect(screen.getByText(/手作業 #184/)).toBeTruthy();
    });
  });

  describe("リリース起動ボタン", () => {
    const unreleased = branchStatus({
      developVsMain: { aheadBy: 3, behindBy: 0 },
      hasReleaseWorkflow: true,
    });

    it("未リリースの変更があり、リリース用workflowを持つときだけ出す", () => {
      renderFlow({ branchStatuses: [unreleased] });
      openRepository();
      expect(screen.getByText("リリースする")).toBeTruthy();
    });

    it("リリース用workflowが無ければ出さない（#1538）", () => {
      renderFlow({
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });
      openRepository();
      expect(screen.queryByText("リリースする")).toBeNull();
    });

    it("未リリースの変更が無ければ出さない", () => {
      renderFlow({
        branchStatuses: [
          branchStatus({ developVsMain: { aheadBy: 0, behindBy: 0 }, hasReleaseWorkflow: true }),
        ],
      });
      openRepository();
      expect(screen.queryByText("リリースする")).toBeNull();
    });

    it("リリースPRが動いている間は出さない", () => {
      renderFlow({
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

    it("確認ダイアログで上げ幅を選べる（#1548）", () => {
      renderFlow({ branchStatuses: [unreleased] });
      openRepository();
      fireEvent.click(screen.getByText("リリースする"));

      expect(screen.getByText("バージョンの上げ幅")).toBeTruthy();
      const options = screen.getAllByRole("radio");
      expect(options.map((option) => option.textContent?.startsWith("自動判定"))).toContain(true);
      // 既定は自動判定
      expect(options[0].getAttribute("aria-checked")).toBe("true");

      fireEvent.click(screen.getByText("minor"));
      expect(screen.getByText("minor").closest("[role='radio']")?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(options[0].getAttribute("aria-checked")).toBe("false");
    });

    it("起動に成功したら、バンプPRが現れるまで押せないままにする（#1548）", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      renderFlow({ branchStatuses: [unreleased] });
      openRepository();
      fireEvent.click(screen.getByText("リリースする"));
      fireEvent.click(screen.getByText("起動する"));

      await screen.findByText("リリースを起動しました");
      expect(screen.getByText("リリース起動中…")).toBeTruthy();
      expect(screen.queryByText("リリースする")).toBeNull();
    });
  });

  describe("mainへのマージ（#1548）", () => {
    const unreleased = branchStatus({
      developVsMain: { aheadBy: 3, behindBy: 0 },
      hasReleaseWorkflow: true,
    });

    it("openなリリースPRにはマージボタンを出す", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1550,
            title: "v3.22.0をmainへリリースする",
            state: "open",
          }),
        ],
        branchStatuses: [unreleased],
      });

      ensureRepositoryOpen();
      expect(screen.getByText("マージする")).toBeTruthy();
    });

    it("押すと本番デプロイが走る旨の確認を挟む", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1550,
            title: "v3.22.0をmainへリリースする",
            state: "open",
          }),
        ],
        branchStatuses: [unreleased],
      });

      ensureRepositoryOpen();
      fireEvent.click(screen.getByText("マージする"));

      expect(screen.getByText("このPRをマージしますか？")).toBeTruthy();
      expect(
        screen.getByText("mainへのマージです。マージすると本番デプロイが走ります。"),
      ).toBeTruthy();
    });

    it("マージ済みのリリースPR（過去の束）にはマージボタンを出さない", () => {
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
            mergedAt: "2026-07-01T00:00:00Z",
          }),
        ],
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 0, behindBy: 0 } })],
      });

      ensureRepositoryOpen();
      expect(screen.queryByText("マージする")).toBeNull();
    });
  });

  describe("バージョンバンプPRの表示（#1548）", () => {
    function makeBumpPullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
      return makePullRequest({
        number: 1547,
        title: "v3.21.0をリリースする",
        headRef: "release/v3.21.0",
        kind: "version-bump",
        // 本文に並ぶリリース対象issueを拾ってしまう状態を再現する
        linkedIssueNumber: 1503,
        linkedIssueNumbers: [1503, 1527],
        state: "open",
        autoMergeEnabled: true,
        ciState: "pending",
        ...overrides,
      });
    }

    const unreleased = branchStatus({
      developVsMain: { aheadBy: 16, behindBy: 0 },
      hasReleaseWorkflow: true,
    });

    it("作業レーンではなく束の見出しの中に出し、無関係なIssueを添えない", () => {
      renderFlow({
        pullRequests: [makeBumpPullRequest()],
        issues: [
          {
            number: 1503,
            title: "共有ワークフローの取得に失敗する",
            repositoryFullName: REPO,
            state: "open",
            projectStatus: "Develop",
          },
        ],
        branchStatuses: [unreleased],
      });

      ensureRepositoryOpen();
      // レーンとしてのブランチ名は出さず、幹の1行として版を出す
      expect(screen.queryByText("release/v3.21.0")).toBeNull();
      expect(screen.getByText("バージョンバンプ v3.21.0")).toBeTruthy();
      expect(screen.getByText("バージョンバンプ中")).toBeTruthy();
      expect(screen.getByText(/#1547 v3.21.0をリリースする/)).toBeTruthy();
      // バンプPRが拾っていた無関係なIssueは出さない
      expect(screen.queryByText(/Issue #1503/)).toBeNull();
    });

    it("Auto-mergeが有効な間はマージボタンを出さない（待てば入るため）", () => {
      renderFlow({ pullRequests: [makeBumpPullRequest()], branchStatuses: [unreleased] });

      ensureRepositoryOpen();
      expect(screen.getByText("Auto-merge有効")).toBeTruthy();
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("Auto-mergeが効かず滞留している場合はマージボタンを出す", () => {
      renderFlow({
        pullRequests: [makeBumpPullRequest({ autoMergeEnabled: false, ciState: "success" })],
        branchStatuses: [unreleased],
      });

      ensureRepositoryOpen();
      expect(screen.getByText("developへマージ待ち")).toBeTruthy();
      expect(screen.getByText("マージする")).toBeTruthy();
    });
  });
  describe("本番デプロイの状態（#1579）", () => {
    const MERGED_AT = "2026-08-15T10:00:00Z";
    const NOW = new Date("2026-08-15T10:01:00Z").getTime();

    const released = [
      makeReleasePullRequest({
        number: 1573,
        title: "v3.22.0をmainへリリースする",
        state: "closed",
        merged: true,
        mergedAt: MERGED_AT,
      }),
      makePullRequest({
        number: 1570,
        headRef: "issue-1524",
        linkedIssueNumber: 1524,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-15T09:00:00Z",
      }),
    ];

    function deployStatuses(
      overrides: Partial<RepositoryDeployStatus["deployRun"] & object> = {},
    ): RepositoryDeployStatus[] {
      return [
        {
          repositoryFullName: REPO,
          deployRun: {
            status: "completed",
            conclusion: "success",
            htmlUrl: `https://github.com/${REPO}/actions/runs/1`,
            createdAt: "2026-08-15T10:00:30Z",
            ...overrides,
          },
        },
      ];
    }

    it("デプロイ実行中は「本番へデプロイ中」を出し、まだ本番反映とは書かない", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({ status: "in_progress", conclusion: null }),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getByText("本番へデプロイ中")).toBeTruthy();
      expect(screen.getByText("8/15にmainへマージ")).toBeTruthy();
      expect(screen.queryByText("8/15に本番反映")).toBeNull();
      // 畳んだ1行にも出す（開かなくても気づけるように）
      expect(screen.getByText("デプロイ中")).toBeTruthy();
    });

    it("デプロイ失敗は実行ログへのリンク付きで出す", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({ conclusion: "failure" }),
        now: NOW,
      });

      ensureRepositoryOpen();
      // 畳んだ1行（ボタンなのでリンクにしない）と束の見出しの2か所に出る
      const badges = screen.getAllByText("デプロイ失敗");
      expect(badges).toHaveLength(2);
      expect(badges.some((badge) => badge.closest("a") === null)).toBe(true);
      expect(
        badges.map((badge) => badge.closest("a")?.getAttribute("href")),
      ).toContain(`https://github.com/${REPO}/actions/runs/1`);
      expect(screen.getByText("8/15にmainへマージ")).toBeTruthy();
    });

    it("デプロイ成功のときだけ「本番反映」と書き、裏付けのバッジを添える", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses(),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getByText("8/15に本番反映")).toBeTruthy();
      expect(screen.getByText("デプロイ成功")).toBeTruthy();
    });

    it("状態が分からないときは従来どおりの表示のまま", () => {
      renderFlow({ pullRequests: released, branchStatuses: [branchStatus()], now: NOW });

      ensureRepositoryOpen();
      expect(screen.getByText("8/15に本番反映")).toBeTruthy();
      expect(screen.queryByText("デプロイ成功")).toBeNull();
    });

    it("mainへのマージ待ちは「mainへマージ待ち」と出す", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1600,
            title: "v3.23.0をmainへリリースする",
            state: "open",
            ciState: "success",
          }),
        ],
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });

      ensureRepositoryOpen();
      expect(screen.getByText("mainへマージ待ち")).toBeTruthy();
    });

    it("CI実行中はまだマージできないので「リリース中」のままにする", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1600,
            title: "v3.23.0をmainへリリースする",
            state: "open",
            ciState: "pending",
          }),
        ],
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });

      ensureRepositoryOpen();
      expect(screen.queryByText("mainへマージ待ち")).toBeNull();
      // 畳んだ1行と束の見出しの2か所に出る
      expect(screen.getAllByText("リリース中").length).toBeGreaterThan(1);
    });
  });
});
