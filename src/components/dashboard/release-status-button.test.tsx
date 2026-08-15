// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseStatusButton } from "@/components/dashboard/release-status-button";
import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import type { ConnectedRepository } from "@/types/repository";

const releaseStatusesMock = vi.hoisted(() => ({ current: [] as RepositoryReleaseStatus[] }));

vi.mock("@/hooks/use-repository-release-statuses", () => ({
  useRepositoryReleaseStatuses: () => ({
    data: releaseStatusesMock.current,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-release-status", () => ({
  useReleaseStatus: () => ({
    data: null,
    isLoading: false,
    error: null,
    triggerRelease: vi.fn(),
    isTriggering: false,
  }),
}));

function repository(fullName: string): ConnectedRepository {
  return {
    id: fullName,
    name: fullName.split("/")[1],
    fullName,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
  };
}

function pendingMergeStatus(repoFullName: string): RepositoryReleaseStatus {
  return {
    repoFullName,
    status: "action_required",
    failedWorkflow: null,
    pendingMerge: {
      mergeTarget: "main",
      pullRequestNumber: 1,
      pullRequestUrl: `https://github.com/${repoFullName}/pull/1`,
      pullRequestTitle: "リリース",
      ciState: "success",
    },
  };
}

/** ポップオーバーの一覧に出ているリポジトリ名を、表示順のまま取り出す */
function listedRepositoryNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span.truncate")?.textContent ?? "");
}

describe("ReleaseStatusButton", () => {
  afterEach(() => {
    releaseStatusesMock.current = [];
    cleanup();
  });

  const repositories = [
    repository("guchi-apps/aide"),
    repository("guchi-apps/asset-manager"),
    repository("guchi-apps/car-care"),
    repository("guchi-apps/clip-hive"),
  ];

  it("マージ待ちのリポジトリを一覧の先頭に出す（#1495）", () => {
    releaseStatusesMock.current = [
      pendingMergeStatus("guchi-apps/car-care"),
      {
        repoFullName: "guchi-apps/clip-hive",
        status: "progressing",
        failedWorkflow: null,
        pendingMerge: null,
      },
    ];
    render(
      <ReleaseStatusButton
        repositories={repositories}
        selectedRepoFullName={null}
        issues={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "リリース" }));

    expect(listedRepositoryNames()).toEqual([
      "guchi-apps/car-care",
      "guchi-apps/clip-hive",
      "guchi-apps/aide",
      "guchi-apps/asset-manager",
    ]);
  });

  it("チェック失敗はマージ待ちよりさらに上に出す", () => {
    releaseStatusesMock.current = [
      pendingMergeStatus("guchi-apps/aide"),
      {
        ...pendingMergeStatus("guchi-apps/clip-hive"),
        pendingMerge: { ...pendingMergeStatus("guchi-apps/clip-hive").pendingMerge!, ciState: "failure" },
      },
    ];
    render(
      <ReleaseStatusButton
        repositories={repositories}
        selectedRepoFullName={null}
        issues={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "リリース" }));

    expect(listedRepositoryNames()).toEqual([
      "guchi-apps/clip-hive",
      "guchi-apps/aide",
      "guchi-apps/asset-manager",
      "guchi-apps/car-care",
    ]);
  });

  it("動いているものが無ければ元の並び（リポジトリ名順）のまま出す", () => {
    render(
      <ReleaseStatusButton
        repositories={repositories}
        selectedRepoFullName={null}
        issues={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "リリース" }));

    expect(listedRepositoryNames()).toEqual(repositories.map((repo) => repo.fullName));
  });
});
