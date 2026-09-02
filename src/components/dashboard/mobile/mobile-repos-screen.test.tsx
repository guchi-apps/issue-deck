// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useRepositoryReleaseStatuses = vi.fn();

vi.mock("@/hooks/use-repository-release-statuses", () => ({
  get useRepositoryReleaseStatuses() {
    return useRepositoryReleaseStatuses;
  },
}));

import { MobileReposScreen } from "@/components/dashboard/mobile/mobile-repos-screen";
import { REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE } from "@/lib/repository-automation";
import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import type { ConnectedRepository } from "@/types/repository";

function repository(overrides: Partial<ConnectedRepository> = {}): ConnectedRepository {
  return {
    id: "repo-1",
    name: "issue-deck",
    fullName: "guchi-apps/issue-deck",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

const REPO_A = repository();
const REPO_B = repository({ id: "repo-2", name: "dayspan", fullName: "guchi-apps/dayspan" });

function renderScreen(releaseStatuses: RepositoryReleaseStatus[] | null) {
  useRepositoryReleaseStatuses.mockReturnValue({
    data: releaseStatuses,
    isLoading: false,
    error: null,
    refetch: vi.fn(async () => []),
  });

  render(
    <MobileReposScreen
      repositories={[REPO_A, REPO_B]}
      allIssueCount={12}
      onSelectRepository={vi.fn()}
      onSelectAllIssues={vi.fn()}
      onSetRepositoryFavorite={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

// #2724でフッターの「Issue」タブを外し、ホームのメニューの「リポジトリ」の行からの
// ドリルダウンになった。見出しは押した行のラベルに揃え、戻る導線を置く
describe("MobileReposScreen のヘッダー（#2724）", () => {
  beforeEach(() => {
    useRepositoryReleaseStatuses.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("見出しは「リポジトリ」で、戻るボタンから1つ前の画面へ戻る", () => {
    const onBack = vi.fn();
    useRepositoryReleaseStatuses.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(async () => []),
    });

    render(
      <MobileReposScreen
        repositories={[REPO_A, REPO_B]}
        allIssueCount={12}
        onSelectRepository={vi.fn()}
        onSelectAllIssues={vi.fn()}
        onSetRepositoryFavorite={vi.fn()}
        onBack={onBack}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("リポジトリ");

    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("MobileReposScreen のリリース状況バッジ（#1117）", () => {
  beforeEach(() => {
    useRepositoryReleaseStatuses.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("取得前はバッジを出さない", () => {
    renderScreen(null);

    expect(screen.queryByText("実施中")).toBeNull();
    expect(screen.queryByText("mainへマージ待ち")).toBeNull();
  });

  it("実行中・マージ待ちをリポジトリごとに出し分ける", () => {
    renderScreen([
      {
        repoFullName: "guchi-apps/issue-deck",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
      {
        repoFullName: "guchi-apps/dayspan",
        status: "action_required",
        failedWorkflow: null,
        pendingMerge: {
          mergeTarget: "main",
          pullRequestNumber: 1,
          pullRequestUrl: "https://github.com/guchi-apps/dayspan/pull/1",
          pullRequestTitle: "release",
          ciState: "success",
        },
      },
    ]);

    expect(screen.getByText("実施中")).toBeTruthy();
    expect(screen.getByText("mainへマージ待ち")).toBeTruthy();
  });

  it("APIが返さなかったリポジトリにはバッジを出さない", () => {
    renderScreen([
      {
        repoFullName: "guchi-apps/issue-deck",
        status: "error",
        failedWorkflow: "deploy",
        pendingMerge: null,
      },
    ]);

    expect(screen.getByText("デプロイ失敗")).toBeTruthy();
    // dayspanは応答に含まれない＝idleなので、バッジは1つだけ。
    expect(screen.queryByText("実施中")).toBeNull();
    expect(screen.queryByText("mainへマージ待ち")).toBeNull();
  });
});

describe("MobileReposScreen のヘッダー（#1685）", () => {
  beforeEach(() => {
    useRepositoryReleaseStatuses.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("表示・非表示を切り替えるアイコンを出さない（設定画面と重複するため削除した）", () => {
    renderScreen(null);

    expect(screen.queryByLabelText("表示・非表示を切り替える")).toBeNull();
    expect(screen.queryByTitle("非表示にする")).toBeNull();
    expect(screen.queryByTitle("表示する")).toBeNull();
  });

  // 通知ベル（#1772）。実行状況を置いている画面には同じように置く
  it("通知ベルを出す", () => {
    renderScreen(null);

    expect(screen.getByRole("button", { name: "対応が必要なもの" })).toBeTruthy();
  });
});

describe("MobileReposScreen の実行経路の印（#1888）", () => {
  beforeEach(() => {
    useRepositoryReleaseStatuses.mockReset();
    useRepositoryReleaseStatuses.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(async () => []),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderWith(repositories: ConnectedRepository[]) {
    render(
      <MobileReposScreen
        repositories={repositories}
        allIssueCount={12}
        onSelectRepository={vi.fn()}
        onSelectAllIssues={vi.fn()}
        onSetRepositoryFavorite={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it("無人実行もサブPCも対応していないリポジトリには印を出す", () => {
    renderWith([repository({ hasClaudeWorkflow: false, dispatchRunnable: false })]);

    expect(screen.getByTitle(REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE)).toBeTruthy();
  });

  it("無人実行が無くてもサブPCで起動できるリポジトリには印を出さない（vps・subpc・docs）", () => {
    renderWith([repository({ hasClaudeWorkflow: false, dispatchRunnable: true })]);

    expect(screen.queryByTitle(REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE)).toBeNull();
  });

  it("無人実行に対応しているリポジトリには印を出さない", () => {
    renderWith([repository({ hasClaudeWorkflow: true, dispatchRunnable: false })]);

    expect(screen.queryByTitle(REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE)).toBeNull();
  });
});

describe("MobileReposScreen の全リポジトリのIssueへの入口（#1951）", () => {
  beforeEach(() => {
    useRepositoryReleaseStatuses.mockReset();
    useRepositoryReleaseStatuses.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(async () => []),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderWithAllIssues(onSelectAllIssues: () => void, allIssueCount = 12) {
    render(
      <MobileReposScreen
        repositories={[REPO_A, REPO_B]}
        allIssueCount={allIssueCount}
        onSelectRepository={vi.fn()}
        onSelectAllIssues={onSelectAllIssues}
        onSetRepositoryFavorite={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it("件数付きの行を出し、押すと横断のIssue一覧を開く", () => {
    const onSelectAllIssues = vi.fn();
    renderWithAllIssues(onSelectAllIssues, 12);

    const button = screen.getByRole("button", { name: /すべてのリポジトリのIssue/ });
    expect(button.textContent).toContain("12");

    fireEvent.click(button);
    expect(onSelectAllIssues).toHaveBeenCalledTimes(1);
  });

  // リポジトリ名の絞り込みで消えると、横断一覧への入口が検索のたびに見当たらなくなる
  it("リポジトリの検索で絞り込んでも消えない", () => {
    renderWithAllIssues(vi.fn());

    fireEvent.change(screen.getByPlaceholderText("リポジトリを検索..."), {
      target: { value: "該当しない名前" },
    });

    expect(screen.getByText("該当するリポジトリがありません")).toBeTruthy();
    expect(screen.getByRole("button", { name: /すべてのリポジトリのIssue/ })).toBeTruthy();
  });
});
