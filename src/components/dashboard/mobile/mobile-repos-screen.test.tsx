// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useRepositoryReleaseStatuses = vi.fn();

vi.mock("@/hooks/use-repository-release-statuses", () => ({
  get useRepositoryReleaseStatuses() {
    return useRepositoryReleaseStatuses;
  },
}));

import { MobileReposScreen } from "@/components/dashboard/mobile/mobile-repos-screen";
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
    refetch: vi.fn(),
  });

  render(
    <MobileReposScreen
      repositories={[REPO_A, REPO_B]}
      onSelectRepository={vi.fn()}
      onHideRepository={vi.fn()}
      onShowRepository={vi.fn()}
      onSetRepositoryFavorite={vi.fn()}
    />,
  );
}

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
