// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { buildBranchFlow, type BranchFlowIssueSource } from "@/lib/branch-flow";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
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
  /** マージ済みPRまで取得済みか（#1711）。既定は取得済み */
  mergedPullRequestsLoaded?: boolean;
  error?: string | null;
  isRefreshing?: boolean;
  /** 自動更新の間隔（#1767）。既定は「自動更新しない」 */
  autoRefreshIntervalMs?: number | null;
  /** デプロイ状況だけが回っている間隔（#1797）。既定は回っていない */
  deployAutoRefreshIntervalMs?: number | null;
  onChangeAutoRefreshInterval?: (intervalMs: number | null) => void;
  onRefresh?: () => void;
  /** マージできたときの後始末（#1756）。渡さない場合は`onRefresh`へ縮退する */
  onMerged?: (pullRequest: PullRequestSummary) => void;
  /** 引っ張って更新（#1958）。渡した画面（スマホ）でだけ有効になる */
  onPullToRefresh?: () => Promise<unknown> | void;
  /** ヘッダーの更新を文字なしのアイコンだけにするか（#1958） */
  refreshIconOnly?: boolean;
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
      isRefreshing={input.isRefreshing}
      error={input.error ?? null}
      failedRepositories={input.failedRepositories ?? []}
      mergedPullRequestsLoaded={input.mergedPullRequestsLoaded ?? true}
      autoRefreshIntervalMs={input.autoRefreshIntervalMs ?? null}
      deployAutoRefreshIntervalMs={input.deployAutoRefreshIntervalMs ?? null}
      onChangeAutoRefreshInterval={input.onChangeAutoRefreshInterval}
      onRefresh={input.onRefresh ?? vi.fn()}
      onMerged={input.onMerged}
      onPullToRefresh={input.onPullToRefresh}
      refreshIconOnly={input.refreshIconOnly}
    />,
  );
}

/** 既定では畳まれているため、中身を見るテストは先に開く */
function openRepository() {
  fireEvent.click(screen.getByText(REPO_SHORT));
}

/**
 * 中身が開いた状態にする。自動展開は無くなった（#1932）ので通常は`openRepository`と同じだが、
 * 開閉の既定が変わっても呼び出し側のテストが壊れないようにこの形で残す。
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
    hasDeployWorkflow: false,
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
      // 件数はアイコンと数字だけで出し、言葉は読み上げ・ツールチップに持たせる（#1886）
      expect(screen.getByLabelText("進行中 1件")).toBeTruthy();
      expect(screen.queryByText("進行中1")).toBeNull();
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

    it("CIが失敗しているリポジトリも畳んだまま並べる（#1932）", () => {
      renderFlow({
        pullRequests: [
          makePullRequest({ number: 1461, headRef: "issue-1454", ciState: "failure" }),
        ],
        branchStatuses: [
          branchStatus({ checkedBranches: ["issue-1454"], existingBranches: ["issue-1454"] }),
        ],
      });

      // 手が要ることは畳んだ行のピルとヘッダーの件数が伝える（開くのはユーザーの操作）
      expect(screen.getByText("CI失敗")).toBeTruthy();
      expect(screen.getByText(/手が要るもの1件/)).toBeTruthy();
      expect(screen.queryByText("issue-1454")).toBeNull();

      openRepository();
      expect(screen.getByText("issue-1454")).toBeTruthy();
    });

    it("ユーザーのマージ待ちは畳んだ行に出さず、ヘッダーの件数だけで伝える（#2172）", () => {
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

      // 畳んだ行にピルは出さない（#2172）。文言が長く、スマホ幅で行が2段に折り返していた
      expect(screen.queryByText("ユーザーのマージが必要")).toBeNull();
      expect(screen.getByText(/手が要るもの1件/)).toBeTruthy();
      expect(screen.queryByText("issue-1454")).toBeNull();

      // 開けば従来どおりバッジとマージボタンが出る（#1469・#1756）
      openRepository();
      expect(screen.getByText("issue-1454")).toBeTruthy();
      expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
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

  /**
   * PCの左右分割（#2157）。
   *
   * 分けるかどうかは画面が占めている幅の実測で決まるが、jsdomはレイアウトを持たず
   * `getBoundingClientRect()`が常に0を返す。**幅を差し替えないテストは従来どおり
   * 折りたたみのまま**で、そこは既存のテストがそのまま押さえている。
   */
  describe("PCの左右分割（#2157）", () => {
    const REPO_B = "guchi-apps/myroom";
    const REPO_B_SHORT = "myroom";
    /** 右ペインの中身にだけ出る文字（左の畳んだ1行には出ない） */
    const REPO_BRANCH = "issue-1454";
    const REPO_B_BRANCH = "issue-5";

    /** 2ペインに分かれる幅があることにする */
    function mockWideLayout(width = 1200) {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width,
        height: 800,
        top: 0,
        left: 0,
        right: width,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    function renderTwoRepositories(
      options: { splitLayout?: boolean; expandedRepositoryFullNames?: string[] } = {},
    ) {
      const flow = buildBranchFlow({
        repositories: [
          { fullName: REPO, private: false },
          { fullName: REPO_B, private: false },
        ],
        pullRequests: [
          makePullRequest({ number: 1461, headRef: REPO_BRANCH }),
          makePullRequest({
            id: `${REPO_B}#7`,
            repositoryFullName: REPO_B,
            number: 7,
            headRef: REPO_B_BRANCH,
          }),
        ],
        issues: [],
        branchStatuses: [
          branchStatus({ checkedBranches: [REPO_BRANCH], existingBranches: [REPO_BRANCH] }),
          branchStatus({
            repositoryFullName: REPO_B,
            checkedBranches: [REPO_B_BRANCH],
            existingBranches: [REPO_B_BRANCH],
          }),
        ],
      });

      return render(
        <BranchFlowView
          flow={flow}
          fetchedAt="2026-08-15T10:30:00Z"
          isLoading={false}
          error={null}
          failedRepositories={[]}
          mergedPullRequestsLoaded
          expandedRepositoryFullNames={options.expandedRepositoryFullNames}
          onRefresh={vi.fn()}
          splitLayout={options.splitLayout ?? true}
        />,
      );
    }

    /** その文字が、畳んだ1行と同じ`<section>`（＝行の下）に出ているか */
    function isInsideRow(rowLabel: string, text: string) {
      const section = screen.getByText(rowLabel).closest("section");
      return section !== null && section.contains(screen.getByText(text));
    }

    it("行をクリックすると、行の下ではなく右ペインに流れ図を出す", () => {
      mockWideLayout();
      renderTwoRepositories();

      fireEvent.click(screen.getByText(REPO_SHORT));

      expect(screen.getByText(REPO_BRANCH)).toBeTruthy();
      expect(isInsideRow(REPO_SHORT, REPO_BRANCH)).toBe(false);
      // 右ペインの見出しは`owner/`まで出す（左の行では落としているため）
      expect(screen.getByRole("heading", { level: 2, name: REPO })).toBeTruthy();
    });

    it("別のリポジトリを選ぶと右ペインが差し替わる（同時に出せるのは1件）", () => {
      mockWideLayout();
      renderTwoRepositories();

      fireEvent.click(screen.getByText(REPO_SHORT));
      expect(screen.getByText(REPO_BRANCH)).toBeTruthy();

      fireEvent.click(screen.getByText(REPO_B_SHORT));
      expect(screen.queryByText(REPO_BRANCH)).toBeNull();
      expect(screen.getByText(REPO_B_BRANCH)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: REPO_B })).toBeTruthy();
    });

    it("何も選んでいないうちは右ペインに選び方を出す", () => {
      mockWideLayout();
      renderTwoRepositories();

      expect(screen.getByText("左の一覧からリポジトリを選ぶと、ここに流れを表示します。")).toBeTruthy();
      expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    });

    it("分割中は「すべて開く」を出さない（同時に1件しか出せないため）", () => {
      mockWideLayout();
      renderTwoRepositories();

      expect(screen.queryByText("すべて開く")).toBeNull();
    });

    it("幅が足りなければ分割せず、今までどおり行の下に開く", () => {
      renderTwoRepositories();

      fireEvent.click(screen.getByText(REPO_SHORT));

      expect(isInsideRow(REPO_SHORT, REPO_BRANCH)).toBe(true);
      expect(screen.getByText("すべて開く")).toBeTruthy();
    });

    it("分割を渡していない画面（スマホ）は、幅が足りても行の下に開く", () => {
      mockWideLayout();
      renderTwoRepositories({ splitLayout: false });

      fireEvent.click(screen.getByText(REPO_SHORT));

      expect(isInsideRow(REPO_SHORT, REPO_BRANCH)).toBe(true);
    });

    it("左メニューで選んだリポジトリの先頭を右へ出す（#1750の「展開」の代わり）", () => {
      mockWideLayout();
      renderTwoRepositories({ expandedRepositoryFullNames: [REPO_B, REPO] });

      expect(screen.getByRole("heading", { level: 2, name: REPO_B })).toBeTruthy();
      expect(screen.getByText(REPO_B_BRANCH)).toBeTruthy();
      // 同時に出せるのは1件なので、ヘッダーも「◯件を展開」とは言わない
      expect(screen.getByText(/絞り込み中の先頭を表示/)).toBeTruthy();
      expect(screen.queryByText(/件を展開/)).toBeNull();
    });

    it("折りたたみのときは今までどおり「◯件を展開」と出す", () => {
      renderTwoRepositories({ expandedRepositoryFullNames: [REPO_B, REPO] });

      expect(screen.getByText(/絞り込み中の2件を展開/)).toBeTruthy();
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
      // 次のリリースに乗る分が無いので、いちばん新しい版の束が既定で開いている（#1711）
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
        // 次のリリースに乗る分がある状態。無いと、いちばん新しい版の束が既定で開く（#1711）
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
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
          mergedPullRequestsLoaded
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
        // 次のリリースに乗る分（未リリースのコミット）がある＝v3.17.0の束は畳まれる。
        // 無いと、いちばん新しい版の束が既定で開く（#1711）
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
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

  describe("本番デプロイ起動ボタン（#2020）", () => {
    const deployable = branchStatus({
      developVsMain: { aheadBy: 3, behindBy: 0 },
      hasDeployWorkflow: true,
    });

    it("deploy.ymlを持つリポジトリを開くと出す", () => {
      renderFlow({ branchStatuses: [deployable] });
      openRepository();
      expect(screen.getByText("本番へ再デプロイ")).toBeTruthy();
    });

    it("deploy.ymlが無ければ出さない", () => {
      renderFlow({
        branchStatuses: [branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 } })],
      });
      openRepository();
      expect(screen.queryByText("本番へ再デプロイ")).toBeNull();
    });

    it("押すと本番へ出るものを確認ダイアログに出す", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1452,
            title: "v3.17.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-01T00:00:00Z",
          }),
        ],
        branchStatuses: [deployable],
      });
      openRepository();
      fireEvent.click(screen.getByText("本番へ再デプロイ"));

      expect(screen.getByText("mainを本番へ出し直しますか？")).toBeTruthy();
      // **developの差分は出ない**ことを、リリースと取り違えないよう明示する
      expect(screen.getByText("3コミットぶんは出ません")).toBeTruthy();
      // いま本番に出ている版を添える（押す前に「同じものが出る」と分かるようにする）
      expect(screen.getByText("いまの本番")).toBeTruthy();
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
      // CIが終わっているリリースPRなので、表示は人のマージ待ちになる（#2038）
      expect(screen.getAllByText("mainへマージ待ち").length).toBeGreaterThan(0);
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

      await screen.findByText("リリース起動中…");
      expect(screen.queryByText("リリースする")).toBeNull();
    });

    it("起動に成功しても完了のポップアップは出さない（#1590）", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      renderFlow({ branchStatuses: [unreleased] });
      openRepository();
      fireEvent.click(screen.getByText("リリースする"));
      fireEvent.click(screen.getByText("起動する"));

      // 確認ダイアログは閉じ、「リリースを起動しました」のダイアログは現れない
      await screen.findByText("リリース起動中…");
      expect(screen.queryByText("リリースを起動しました")).toBeNull();
      expect(screen.queryByText("リリースworkflowを起動しますか？")).toBeNull();
    });

    describe("畳んだ1行の「リリース起動中」（#1955）", () => {
      async function trigger() {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
        fireEvent.click(screen.getByText("リリースする"));
        fireEvent.click(screen.getByText("起動する"));
        await screen.findByText("リリース起動中…");
      }

      it("起動すると、行を畳んでも「リリース起動中」が残る", async () => {
        renderFlow({ branchStatuses: [unreleased] });
        openRepository();
        await trigger();

        expect(screen.getByText("リリース起動中")).toBeTruthy();

        // 畳んでも、押したことと進んでいることが行から分かる（開いた中身のボタンは消える）
        fireEvent.click(screen.getByText(REPO_SHORT));
        expect(screen.getByText("リリース起動中")).toBeTruthy();
        expect(screen.queryByText("リリース起動中…")).toBeNull();
      });

      it("起動中は「未リリース ◯コミット」を出さない（リリース中と同じ扱い）", async () => {
        renderFlow({ branchStatuses: [unreleased] });
        openRepository();
        expect(screen.getAllByLabelText("未リリース 3コミット").length).toBeGreaterThan(0);

        await trigger();
        expect(screen.queryByLabelText("未リリース 3コミット")).toBeNull();
      });

      it("押していなければ出さない", () => {
        renderFlow({ branchStatuses: [unreleased] });
        expect(screen.queryByText("リリース起動中")).toBeNull();
      });

      it("バンプPRが現れたら「リリース中」へ引き継ぐ", () => {
        // 起動の記録は端末に残ったまま、バンプPRが画面に現れた状態
        window.localStorage.setItem(
          `issue-deck:release-triggered-at:${REPO}`,
          JSON.stringify(new Date().toISOString()),
        );
        renderFlow({
          pullRequests: [
            makePullRequest({
              number: 1547,
              title: "v3.21.0をリリースする",
              headRef: "release/v3.21.0",
              kind: "version-bump",
              state: "open",
              ciState: "pending",
            }),
          ],
          branchStatuses: [unreleased],
        });

        expect(screen.getByText("リリース中")).toBeTruthy();
        expect(screen.queryByText("リリース起動中")).toBeNull();
      });
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

  describe("作業ブランチのPRのマージ（#1756）", () => {
    /** ユーザーがマージするしかないdevelop向けPR（`00.check-user` + `01.check-merge`） */
    function userMergePullRequest(overrides: Partial<PullRequestSummary> = {}) {
      return makePullRequest({
        number: 91,
        headRef: "issue-88",
        linkedIssueNumber: 88,
        linkedIssueCheckUser: true,
        linkedIssueCheckReason: "merge",
        ...overrides,
      });
    }

    it("ユーザーのマージが必要なPRにはボタンと理由のバッジを出す", () => {
      renderFlow({ pullRequests: [userMergePullRequest()] });

      ensureRepositoryOpen();
      expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
      expect(screen.getByText("マージする")).toBeTruthy();
    });

    it("自動でマージされるPRには出さない（押す必要が無いものを押させない）", () => {
      renderFlow({
        pullRequests: [
          userMergePullRequest({ linkedIssueCheckUser: false, linkedIssueCheckReason: null }),
        ],
      });

      ensureRepositoryOpen();
      expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("Auto-merge有効なPRには出さない（待てば入る）", () => {
      renderFlow({ pullRequests: [userMergePullRequest({ autoMergeEnabled: true })] });

      ensureRepositoryOpen();
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("コンフリクトしているPRにはボタンを出さない（バッジは出す）", () => {
      renderFlow({ pullRequests: [userMergePullRequest({ mergeable: false })] });

      ensureRepositoryOpen();
      expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("CIが通っていればダイアログを挟まずマージし、onMergedへ対象のPRを渡す", async () => {
      // この describe の afterEach が拾えるよう、stubGlobalではなくspyOnで差し替える
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const onMerged = vi.fn();
      const pullRequest = userMergePullRequest();

      renderFlow({ pullRequests: [pullRequest], onMerged });
      ensureRepositoryOpen();
      fireEvent.click(screen.getByText("マージする"));

      await screen.findByText("マージ済み");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onMerged).toHaveBeenCalledWith(expect.objectContaining({ id: pullRequest.id }));
    });

    it("マージ後のボタンは無効のまま残し、二度目の要求を飛ばさない", async () => {
      // この describe の afterEach が拾えるよう、stubGlobalではなくspyOnで差し替える
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      renderFlow({ pullRequests: [userMergePullRequest()], onMerged: vi.fn() });
      ensureRepositoryOpen();
      fireEvent.click(screen.getByText("マージする"));

      const merged = await screen.findByText("マージ済み");
      fireEvent.click(merged);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("マージ済みになったPRからはボタンが消える（親が取得を待たず反映した後）", () => {
      renderFlow({
        pullRequests: [
          userMergePullRequest({
            state: "closed",
            merged: true,
            mergedAt: "2026-08-16T10:00:00Z",
          }),
        ],
      });

      ensureRepositoryOpen();
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("リリースPRのマージボタンは束の見出しの1つだけ（行と二重に出さない）", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1550,
            title: "v3.22.0をmainへリリースする",
            state: "open",
          }),
        ],
        branchStatuses: [
          branchStatus({ developVsMain: { aheadBy: 3, behindBy: 0 }, hasReleaseWorkflow: true }),
        ],
      });

      ensureRepositoryOpen();
      expect(screen.getAllByText("マージする")).toHaveLength(1);
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
      // 畳んだ1行（琥珀のピル）と幹のバンプPRの行の2か所に出る（#2038）
      expect(screen.getAllByText("developへマージ待ち")).toHaveLength(2);
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
            // 既定はmainへのpushで走った本番反映（手動の出し直しは`event`で分ける。#2020）
            event: "push",
            // 既定は初回の試行（自動再実行は`runAttempt`で分ける。#2134）
            runAttempt: 1,
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
      // 次のリリースに乗る分が無いので、いちばん新しい版の束が既定で開いている（#1711）
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
      // 次のリリースに乗る分が無いので、いちばん新しい版の束が既定で開いている（#1711）
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
      // 次のリリースに乗る分が無いので、いちばん新しい版の束が既定で開いている（#1711）
      expect(screen.getByText("8/15に本番反映")).toBeTruthy();
      expect(screen.getByText("デプロイ成功")).toBeTruthy();
    });

    // 計画レビューの指摘1（#2020）。出し直しは「その版が本番へ出たか」を表さない
    it("手動の出し直し中でも、すでに出た版の「本番反映」を取り消さない", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({
          status: "in_progress",
          conclusion: null,
          event: "workflow_dispatch",
          createdAt: "2026-08-15T10:05:00Z",
        }),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getByText("8/15に本番反映")).toBeTruthy();
      expect(screen.queryByText("8/15にmainへマージ")).toBeNull();
      // 状態そのものは、リリースの本番反映とは別の言葉で出す
      expect(screen.getByText("本番へ再デプロイ中")).toBeTruthy();
      expect(screen.getByText("再デプロイ中")).toBeTruthy();
    });

    it("手動の出し直しに失敗しても、すでに出た版の「本番反映」を取り消さない", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({
          conclusion: "failure",
          event: "workflow_dispatch",
          createdAt: "2026-08-15T10:05:00Z",
        }),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getByText("8/15に本番反映")).toBeTruthy();
      expect(screen.getAllByText("再デプロイ失敗").length).toBeGreaterThan(0);
      expect(screen.queryByText("デプロイ失敗")).toBeNull();
    });

    // #2134。走っている最中に何も言わないと、人は自分で「本番へ再デプロイ」を押しに行く
    // しかないと読む
    it("自動再実行中は「自動で再デプロイ中」と出す", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({
          status: "in_progress",
          conclusion: null,
          runAttempt: 2,
        }),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getAllByText("自動で再デプロイ中").length).toBeGreaterThan(0);
      expect(screen.queryByText("本番へデプロイ中")).toBeNull();
    });

    // やり直しても駄目だった＝人が見る番になった、と読めるようにする
    it("自動再実行しても失敗したときは、初回の失敗と言葉を分ける", () => {
      renderFlow({
        pullRequests: released,
        branchStatuses: [branchStatus()],
        deployStatuses: deployStatuses({ conclusion: "failure", runAttempt: 2 }),
        now: NOW,
      });

      ensureRepositoryOpen();
      expect(screen.getByText("再デプロイしても失敗")).toBeTruthy();
      expect(screen.queryByText("デプロイ失敗")).toBeNull();
    });

    it("状態が分からないときは従来どおりの表示のまま", () => {
      renderFlow({ pullRequests: released, branchStatuses: [branchStatus()], now: NOW });

      ensureRepositoryOpen();
      // 次のリリースに乗る分が無いので、いちばん新しい版の束が既定で開いている（#1711）
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
      // 畳んだ1行と束の見出しの2か所に出す（#2038）。開かなくても押す番だと分かるようにする
      expect(screen.getAllByText("mainへマージ待ち")).toHaveLength(2);
      // 「リリース中」（待てば進む）とは同時に出さない
      expect(screen.queryByText("リリース中")).toBeNull();
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

    // 自動で進んでいるのか、人がマージする番なのかを行を開かずに見分けられるようにする（#1931）
    it("CI実行中の「リリース中」にはローディングを添える", () => {
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
      // 畳んだ1行と束の見出しの両方に付く
      const pills = screen.getAllByLabelText("リリース中（チェック実行中）");
      expect(pills).toHaveLength(2);
      // 「デプロイ中」と同じ回るアイコン。止まったアイコンを添えても状態は伝わらない
      pills.forEach((pill) => expect(pill.querySelector(".animate-spin")).toBeTruthy());
    });

    it("CIが終わっていればローディングは出さない（止まっている状態を回さない）", () => {
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
      // CIが終わった時点で「リリース中」ではなくなる（#2038）。止まっている状態を回さない
      expect(screen.queryByLabelText("リリース中（チェック実行中）")).toBeNull();
      expect(screen.queryByText("リリース中")).toBeNull();
    });
  });

  /**
   * 本番デプロイの直後（#1711）。進行中の作業もdevelopとmainの差も無いため、
   * この画面に出るものはリリース済みの束しか残らない。
   */
  /**
   * 畳んだ1行とヘッダーの件数で、待てばよいのか自分が押す番なのかを見分ける（#2038）。
   * どちらも行を開かずに読むものなので、開かない状態で確かめる。
   */
  describe("リリース中と押す番の見分け（#2038）", () => {
    const unreleased = branchStatus({
      developVsMain: { aheadBy: 3, behindBy: 0 },
      hasReleaseWorkflow: true,
    });

    function renderRelease(ciState: PullRequestSummary["ciState"]) {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1600,
            title: "v3.23.0をmainへリリースする",
            state: "open",
            ciState,
          }),
        ],
        branchStatuses: [unreleased],
      });
    }

    it("CIが終わっていれば、畳んだままでも「mainへマージ待ち」と出す", () => {
      renderRelease("success");

      expect(screen.getByText("mainへマージ待ち")).toBeTruthy();
      expect(screen.queryByText("リリース中")).toBeNull();
      expect(screen.getByText(/手が要るもの1件/)).toBeTruthy();
      expect(screen.queryByText(/待てば進むもの/)).toBeNull();
    });

    it("CI実行中は「リリース中」のままで、件数も「待てば進むもの」に入れる", () => {
      renderRelease("pending");

      expect(screen.getByText("リリース中")).toBeTruthy();
      expect(screen.queryByText("mainへマージ待ち")).toBeNull();
      expect(screen.getByText(/待てば進むもの1件/)).toBeTruthy();
      expect(screen.queryByText(/手が要るもの/)).toBeNull();
    });

    // 赤の「CI失敗」と重ねない（直すのかマージするのかを取り違えさせない。#1059）
    it("CIが落ちていれば「CI失敗」だけを出す", () => {
      renderRelease("failure");

      expect(screen.getByText("CI失敗")).toBeTruthy();
      expect(screen.queryByText("mainへマージ待ち")).toBeNull();
      expect(screen.getByText(/手が要るもの1件/)).toBeTruthy();
    });

    // 押す操作は無いが、本番へ出るまでを見に来る手掛かりは残す（#1579の意図）
    it("デプロイ中は「待てば進むもの」に数える", () => {
      renderFlow({
        pullRequests: [
          makeReleasePullRequest({
            number: 1573,
            title: "v3.22.0をmainへリリースする",
            state: "closed",
            merged: true,
            mergedAt: "2026-08-15T10:00:00Z",
          }),
        ],
        branchStatuses: [branchStatus()],
        deployStatuses: [
          {
            repositoryFullName: REPO,
            deployRun: {
              status: "in_progress",
              conclusion: null,
              htmlUrl: `https://github.com/${REPO}/actions/runs/1`,
              createdAt: "2026-08-15T10:00:30Z",
              event: "push",
              runAttempt: 1,
            },
          },
        ],
        now: new Date("2026-08-15T10:01:00Z").getTime(),
      });

      expect(screen.getByText(/待てば進むもの1件/)).toBeTruthy();
      expect(screen.queryByText(/手が要るもの/)).toBeNull();
    });
  });

  describe("本番デプロイ直後", () => {
    /** v3.17.0で本番へ出たレーンだけがある状態（未リリースの分は無い） */
    const justReleased = [
      makeReleasePullRequest({
        number: 920,
        title: "v3.17.0をmainへリリースする",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-10T00:00:00Z",
      }),
      makeReleasePullRequest({
        number: 910,
        title: "v3.16.0をmainへリリースする",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-05T00:00:00Z",
      }),
      makePullRequest({
        number: 915,
        headRef: "issue-915",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-08T00:00:00Z",
      }),
      makePullRequest({
        number: 905,
        headRef: "issue-905",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-03T00:00:00Z",
      }),
    ];

    it("次のリリースに乗る分が無いときは、いちばん新しい版の束を既定で出す（#1711）", () => {
      renderFlow({ pullRequests: justReleased, branchStatuses: [branchStatus()] });

      ensureRepositoryOpen();
      expect(screen.getByText("issue-915")).toBeTruthy();
      expect(screen.getByText("このバージョンに乗った変更 1件")).toBeTruthy();
      // ひとつ前の版は従来どおり畳んだまま
      expect(screen.queryByText("issue-905")).toBeNull();
      expect(screen.getByText("リリース済みのバージョンを表示（1件）")).toBeTruthy();
      expect(screen.queryByText("developへ向かっている作業はありません。")).toBeNull();
    });

    it("マージ済みPRが揃うまでは「作業はありません」と言い切らない（#1711）", () => {
      renderFlow({
        // 母集団が`open`のままの一瞬を再現する（クローズ済みのPRがまだ1件も入っていない）
        pullRequests: [],
        branchStatuses: [branchStatus()],
        mergedPullRequestsLoaded: false,
      });

      openRepository();
      expect(screen.getByText("リリース済みのバージョンを読み込み中...")).toBeTruthy();
      expect(screen.queryByText("developへ向かっている作業はありません。")).toBeNull();
      // 畳んだ行も「動きなし」と言い切らない
      expect(screen.getByText("読み込み中")).toBeTruthy();
      expect(screen.queryByText("動きなし")).toBeNull();
    });

    it("取得に失敗したときは読み込み中で止めない（#1711）", () => {
      renderFlow({
        pullRequests: [],
        branchStatuses: [branchStatus()],
        mergedPullRequestsLoaded: false,
        error: "リクエストに失敗しました (500)",
      });

      openRepository();
      expect(screen.queryByText("リリース済みのバージョンを読み込み中...")).toBeNull();
      expect(screen.getByText("developへ向かっている作業はありません。")).toBeTruthy();
    });

    it("マージ済みPRが揃えば、いつもどおりの空状態に戻る（#1711）", () => {
      renderFlow({ pullRequests: [], branchStatuses: [branchStatus()] });

      openRepository();
      expect(screen.getByText("developへ向かっている作業はありません。")).toBeTruthy();
      expect(screen.getByText("動きなし")).toBeTruthy();
      expect(screen.queryByText("リリース済みのバージョンを読み込み中...")).toBeNull();
    });

    it("手が要るリポジトリでも自動で開かない（#1932）", () => {
      const flow = buildBranchFlow({
        repositories: [{ fullName: REPO, private: false }],
        // CIが落ちている＝手が要る。以前（#1711）はこの条件で自動展開していた
        pullRequests: [makePullRequest({ number: 940, ciState: "failure" })],
        issues: [],
        branchStatuses: [branchStatus()],
      });
      const props = {
        flow,
        fetchedAt: "2026-08-15T10:30:00Z",
        isLoading: false,
        error: null,
        failedRepositories: [],
        onRefresh: vi.fn(),
      };

      const { rerender } = render(<BranchFlowView {...props} mergedPullRequestsLoaded={false} />);
      expect(screen.getByText(REPO_SHORT).closest("button")?.getAttribute("aria-expanded")).toBe(
        "false",
      );

      // マージ済みPRまで揃っても畳んだまま。開くのはユーザーの操作だけ
      rerender(<BranchFlowView {...props} mergedPullRequestsLoaded />);
      expect(screen.getByText(REPO_SHORT).closest("button")?.getAttribute("aria-expanded")).toBe(
        "false",
      );

      openRepository();
      expect(screen.getByText(REPO_SHORT).closest("button")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
    });

    it("どの版で出たか特定できない変更しか無いときもボタンを出す（#1711）", () => {
      renderFlow({
        // リリースPRを1件も取得できていない＝版を決められないマージ済みレーン
        pullRequests: [
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
      expect(screen.queryByText("issue-915")).toBeNull();
      fireEvent.click(screen.getByText("本番へ出た変更を表示（1件）"));
      expect(screen.getByText("issue-915")).toBeTruthy();
    });
  });
});

/**
 * 左メニューのリポジトリ絞り込みを、この画面では「展開」として効かせる（#1750）。
 * 母集団は絞らないので、選ばれていないリポジトリも畳んだ行として残る。
 */
describe("選択中リポジトリの展開（#1750）", () => {
  const OTHER = "guchi-apps/car-care";

  function renderTwoRepositories(expandedRepositoryFullNames: string[]) {
    const flow = buildBranchFlow({
      repositories: [
        { fullName: REPO, private: false },
        { fullName: OTHER, private: false },
      ],
      pullRequests: [],
      issues: [],
      branchStatuses: [],
    });

    return render(
      <BranchFlowView
        flow={flow}
        fetchedAt="2026-08-15T10:30:00Z"
        isLoading={false}
        error={null}
        failedRepositories={[]}
        mergedPullRequestsLoaded
        expandedRepositoryFullNames={expandedRepositoryFullNames}
        onRefresh={vi.fn()}
      />,
    );
  }

  function repositoryRow(shortName: string) {
    return screen.getByText(shortName).closest("button");
  }

  afterEach(cleanup);

  it("選択中のリポジトリだけを開いた状態にし、他は畳んだまま残す", () => {
    renderTwoRepositories([REPO]);

    expect(repositoryRow(REPO_SHORT)?.getAttribute("aria-expanded")).toBe("true");
    expect(repositoryRow("car-care")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("選択があることをヘッダーに出す", () => {
    renderTwoRepositories([REPO]);
    expect(screen.getByText(/絞り込み中の1件を展開/)).toBeTruthy();
  });

  it("選択が無ければ従来どおり（すべて畳む・注記も出さない）", () => {
    renderTwoRepositories([]);

    expect(repositoryRow(REPO_SHORT)?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/絞り込み中の/)).toBeNull();
  });

  it("手で畳んだあとは、再描画で勝手に開き直さない", () => {
    const { rerender } = renderTwoRepositories([REPO]);
    fireEvent.click(screen.getByText(REPO_SHORT));
    expect(repositoryRow(REPO_SHORT)?.getAttribute("aria-expanded")).toBe("false");

    const flow = buildBranchFlow({
      repositories: [
        { fullName: REPO, private: false },
        { fullName: OTHER, private: false },
      ],
      pullRequests: [],
      issues: [],
      branchStatuses: [],
    });
    rerender(
      <BranchFlowView
        flow={flow}
        fetchedAt="2026-08-15T10:31:00Z"
        isLoading={false}
        error={null}
        failedRepositories={[]}
        mergedPullRequestsLoaded
        expandedRepositoryFullNames={[REPO]}
        onRefresh={vi.fn()}
      />,
    );

    expect(repositoryRow(REPO_SHORT)?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("実装予定のIssue（#1704）", () => {
  afterEach(() => {
    cleanup();
  });

  /** 未着手のIssueを番号だけ変えて並べる */
  function plannedIssues(numbers: number[]): BranchFlowIssueSource[] {
    return numbers.map((number) => ({
      number,
      title: `やること${number}`,
      repositoryFullName: REPO,
      state: "open",
      projectStatus: "Ready",
    }));
  }

  it("畳んだ1行にはアイコンと数字だけを出す（#1886）", () => {
    renderFlow({ issues: plannedIssues([10, 11]), branchStatuses: [branchStatus()] });

    expect(screen.getByLabelText("実装予定 2件")).toBeTruthy();
    expect(screen.queryByText("予定2")).toBeNull();
    // 開いたときの見出しは畳んだ状態では出さない
    expect(screen.queryByText(/実装予定 2件/)).toBeNull();
  });

  it("開くと既定で3件まで出し、残りはボタンで開く", () => {
    renderFlow({
      issues: plannedIssues([10, 11, 12, 13, 14]),
      branchStatuses: [branchStatus()],
    });
    ensureRepositoryOpen();

    expect(screen.getByText("実装予定 5件")).toBeTruthy();
    expect(screen.getByText(/Issue #14/)).toBeTruthy();
    expect(screen.queryByText(/Issue #11/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "実装予定の残り2件を表示" }));
    expect(screen.getByText(/Issue #11/)).toBeTruthy();
    expect(screen.getByText(/Issue #10/)).toBeTruthy();

    // 押し直すと頭出しへ戻る
    fireEvent.click(screen.getByRole("button", { name: "実装予定を3件だけ表示" }));
    expect(screen.queryByText(/Issue #10/)).toBeNull();
  });

  it("3件以下なら展開ボタンは出さない", () => {
    renderFlow({ issues: plannedIssues([10, 11]), branchStatuses: [branchStatus()] });
    ensureRepositoryOpen();

    expect(screen.getByText("実装予定 2件")).toBeTruthy();
    // 畳んだ行のボタンも読み上げに「実装予定 2件」を持つため、展開ボタンの文言で見る（#1886）
    expect(screen.queryByRole("button", { name: /実装予定(の残り|を)/ })).toBeNull();
  });

  it("優先度が付いているIssueにはピルを出す", () => {
    renderFlow({
      issues: [
        {
          number: 20,
          title: "急ぎのやること",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Ready",
          labels: ["80.Priority: High"],
        },
      ],
      branchStatuses: [branchStatus()],
    });
    ensureRepositoryOpen();

    expect(screen.getByText("優先度 高")).toBeTruthy();
  });

  it("実装予定が無ければ見出しごと出さない", () => {
    renderFlow({
      issues: [
        {
          number: 30,
          title: "実装中のもの",
          repositoryFullName: REPO,
          state: "open",
          projectStatus: "Implementation",
        },
      ],
      branchStatuses: [branchStatus()],
    });
    ensureRepositoryOpen();

    expect(screen.queryByText(/実装予定/)).toBeNull();
    expect(screen.queryByLabelText(/実装予定/)).toBeNull();
  });
});

describe("BranchFlowView の自動更新（#1767）", () => {
  afterEach(() => {
    cleanup();
  });

  it("自動更新中は何分間隔なのかをヘッダーに出す", () => {
    renderFlow({ autoRefreshIntervalMs: 60_000 });

    expect(screen.getByText(/自動更新1分間隔/)).toBeTruthy();
  });

  // #1797。何も出さないと「自動更新していない」のか「この画面は状態を出さない」のかを
  // 見分けられないため、黙らずに言い切る
  it("自動更新しないときは「手動更新のみ」と出す", () => {
    renderFlow({ autoRefreshIntervalMs: null });

    expect(screen.getByText(/手動更新のみ/)).toBeTruthy();
  });

  it("更新ボタンのツールチップに、押すと何が起きるかと自動更新の状態を出す（#1797）", () => {
    renderFlow({ autoRefreshIntervalMs: 60_000 });
    expect(screen.getByRole("button", { name: "更新" }).getAttribute("title")).toBe(
      "今すぐ更新（自動更新1分間隔）",
    );

    cleanup();
    renderFlow({ autoRefreshIntervalMs: null });
    expect(screen.getByRole("button", { name: "更新" }).getAttribute("title")).toBe(
      "今すぐ更新（手動更新のみ）",
    );
  });

  // デプロイ状況（`use-deploy-status.ts`）だけは、この画面が「自動更新しない」設定でも
  // デプロイが動いている間は30秒ごとに回っている（#1797）
  it("デプロイ中に回っているぶんは、その旨を添える", () => {
    renderFlow({ autoRefreshIntervalMs: null, deployAutoRefreshIntervalMs: 30_000 });

    expect(screen.getByText(/手動更新のみ/)).toBeTruthy();
    expect(screen.getByText(/デプロイ中は30秒間隔で確認/)).toBeTruthy();
  });

  it("自動更新中の取得でも更新アイコンを回す（isLoadingは立てない）", () => {
    const { container } = renderFlow({ isRefreshing: true });

    // 更新ボタンは押せるまま（自動更新のたびに無効化しない）
    const refreshButton = screen.getByRole("button", { name: "更新" });
    expect(refreshButton.hasAttribute("disabled")).toBe(false);
    expect(container.querySelectorAll(".animate-spin").length).toBe(1);
  });

  it("取得していない間は更新アイコンを回さない", () => {
    const { container } = renderFlow({ isRefreshing: false });

    expect(container.querySelectorAll(".animate-spin").length).toBe(0);
  });

  it("間隔を変える導線は、いまの間隔をラベルに出す", () => {
    renderFlow({ autoRefreshIntervalMs: 300_000, onChangeAutoRefreshInterval: vi.fn() });

    expect(screen.getByRole("button", { name: "自動更新の間隔（現在: 5分間隔）" })).toBeTruthy();
  });

  it("間隔を変える手段が無い画面では、その導線を出さない", () => {
    renderFlow({});

    expect(screen.queryByRole("button", { name: /自動更新の間隔/ })).toBeNull();
  });
});

// 引っ張って更新とスマホのヘッダー（#1958）
describe("BranchFlowView の引っ張って更新（#1958）", () => {
  afterEach(cleanup);

  // jsdomには`TouchEvent`のコンストラクタが無いため、ハンドラが読む`touches`だけを持つ
  // イベントを組み立てる（`use-pull-to-refresh.test.tsx`と同じ作り）
  function touchEvent(type: string, x: number, y: number) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
    return event;
  }

  /** 引っ張りのタッチを受ける枠（スクロール領域を包む枠） */
  function pullContainer(container: HTMLElement) {
    const scroller = container.querySelector(".overflow-y-auto");
    if (!scroller?.parentElement) throw new Error("スクロール領域が見つからない");
    return scroller.parentElement;
  }

  it("下へ引っ張ると表示が出て、離すと更新が走る", async () => {
    const onPullToRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderFlow({ onPullToRefresh });
    const target = pullContainer(container);

    act(() => {
      target.dispatchEvent(touchEvent("touchstart", 100, 100));
      target.dispatchEvent(touchEvent("touchmove", 100, 140));
    });
    expect(screen.getByText("引っ張って更新")).toBeTruthy();

    act(() => {
      target.dispatchEvent(touchEvent("touchmove", 100, 300));
    });
    expect(screen.getByText("離すと更新")).toBeTruthy();

    await act(async () => {
      target.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(onPullToRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("更新中…")).toBeTruthy();
  });

  it("引っ張って更新を渡さない画面（PC）では反応しない", () => {
    const { container } = renderFlow({});
    const target = pullContainer(container);

    act(() => {
      target.dispatchEvent(touchEvent("touchstart", 100, 100));
      target.dispatchEvent(touchEvent("touchmove", 100, 300));
    });
    expect(screen.queryByText("離すと更新")).toBeNull();
  });

  it("スマホでは更新ボタンを文字なしのアイコンだけにする", () => {
    renderFlow({ refreshIconOnly: true });
    const button = screen.getByRole("button", { name: "更新" });
    expect(button.textContent).toBe("");
  });

  it("PCでは更新ボタンに文字を出す", () => {
    renderFlow({});
    expect(screen.getByRole("button", { name: "更新" }).textContent).toBe("更新");
  });
});
