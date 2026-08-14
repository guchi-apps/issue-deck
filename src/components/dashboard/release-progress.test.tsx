// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseProgress } from "@/components/dashboard/release-progress";
import type { CiState, ReleaseStatus } from "@/hooks/use-release-status";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

function makeStatus(overrides: Partial<AvailableReleaseStatus>): AvailableReleaseStatus {
  return {
    available: true,
    mainVersion: "1.0.0",
    developVersion: "1.1.0",
    phase: "none",
    workflowRun: null,
    deployWorkflowRun: null,
    bumpPullRequest: null,
    releasePullRequest: null,
    otherPullRequests: [],
    ...overrides,
  };
}

function statusWithReleaseCi(
  ciState: CiState | null,
  mergeable: boolean | null = null,
): AvailableReleaseStatus {
  return makeStatus({
    phase: "release_pr_open",
    releasePullRequest: {
      number: 42,
      url: "https://example.com/pr/42",
      title: "release",
      ciState,
      mergeable,
    },
  });
}

describe("ReleaseProgress CI状態バッジ", () => {
  afterEach(() => {
    cleanup();
  });

  it("CI実行中はCI実行中バッジを表示する", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("pending")} />);
    expect(screen.getByText("CI実行中")).not.toBeNull();
  });

  it("CI通過はCI通過バッジを表示する", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("success")} />);
    expect(screen.getByText("CI通過")).not.toBeNull();
  });

  it("CI失敗はCI失敗バッジを表示する", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("failure")} />);
    expect(screen.getByText("CI失敗")).not.toBeNull();
  });

  it("CI状態が不明な場合はCI状態は不明バッジを表示する", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("unknown")} />);
    expect(screen.getByText("CI状態は不明")).not.toBeNull();
  });

  it("CI状態が取得できない場合はバッジを表示しない", () => {
    render(<ReleaseProgress status={statusWithReleaseCi(null)} />);
    expect(screen.queryByText("CI実行中")).toBeNull();
    expect(screen.queryByText("CI通過")).toBeNull();
    expect(screen.queryByText("CI失敗")).toBeNull();
    expect(screen.queryByText("CI状態は不明")).toBeNull();
  });

  it("バンプPRのマージ待ち段でもCI状態バッジを表示する", () => {
    render(
      <ReleaseProgress
        status={makeStatus({
          phase: "bump_pr_open",
          bumpPullRequest: {
            number: 7,
            url: "https://example.com/pr/7",
            title: "bump",
            ciState: "failure",
            mergeable: null,
            version: "1.1.0",
            reason: null,
            changelog: null,
          },
        })}
      />,
    );
    expect(screen.getByText("CI失敗")).not.toBeNull();
  });
});

describe("ReleaseProgress 更新履歴表示", () => {
  afterEach(() => {
    cleanup();
  });

  function statusWithBump(reason: string | null, changelog: string | null): AvailableReleaseStatus {
    return makeStatus({
      phase: "bump_pr_open",
      bumpPullRequest: {
        number: 7,
        url: "https://example.com/pr/7",
        title: "bump",
        ciState: null,
        mergeable: null,
        version: "1.1.0",
        reason,
        changelog,
      },
    });
  }

  it("changelogがある場合は更新履歴を判断根拠と並べて表示する", () => {
    render(<ReleaseProgress status={statusWithBump("判断根拠のテキスト", "更新履歴のテキスト")} />);
    expect(screen.getByText("判断根拠")).not.toBeNull();
    expect(screen.getByText("判断根拠のテキスト")).not.toBeNull();
    expect(screen.getByText("更新履歴（利用者向け）")).not.toBeNull();
    expect(screen.getByText("更新履歴のテキスト")).not.toBeNull();
  });

  it("changelogが無い場合は更新履歴のボックスを表示しない", () => {
    render(<ReleaseProgress status={statusWithBump("判断根拠のテキスト", null)} />);
    expect(screen.getByText("判断根拠のテキスト")).not.toBeNull();
    expect(screen.queryByText("更新履歴（利用者向け）")).toBeNull();
  });
});

describe("ReleaseProgress 自動修復ボタン（#1293）", () => {
  afterEach(() => {
    cleanup();
  });

  it("本番へのリリースPRのCIが失敗しているとCI修正ボタンを出す", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("failure")} repoFullName="owner/repo" />);
    expect(screen.getByRole("button", { name: "CI失敗を自動修正" })).not.toBeNull();
  });

  it("本番へのリリースPRがコンフリクトしていると解消ボタンとバッジを出す", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("success", false)} repoFullName="owner/repo" />);
    expect(screen.getByText("コンフリクトあり")).not.toBeNull();
    expect(screen.getByRole("button", { name: "コンフリクトを自動解消" })).not.toBeNull();
  });

  it("CIが通っていてコンフリクトも無ければボタンを出さない", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("success", true)} repoFullName="owner/repo" />);
    expect(screen.queryByRole("button", { name: "CI失敗を自動修正" })).toBeNull();
    expect(screen.queryByRole("button", { name: "コンフリクトを自動解消" })).toBeNull();
  });

  it("repoFullNameが渡されない場合は起動先が決まらないためボタンを出さない", () => {
    render(<ReleaseProgress status={statusWithReleaseCi("failure", false)} />);
    expect(screen.queryByRole("button", { name: "CI失敗を自動修正" })).toBeNull();
    expect(screen.queryByRole("button", { name: "コンフリクトを自動解消" })).toBeNull();
  });

  it("バンプPR（develop向け）のCI失敗にも同じボタンを出す", () => {
    render(
      <ReleaseProgress
        status={makeStatus({
          phase: "bump_pr_open",
          bumpPullRequest: {
            number: 7,
            url: "https://example.com/pr/7",
            title: "bump",
            ciState: "failure",
            mergeable: null,
            version: "1.1.0",
            reason: null,
            changelog: null,
          },
        })}
        repoFullName="owner/repo"
      />,
    );
    expect(screen.getByRole("button", { name: "CI失敗を自動修正" })).not.toBeNull();
  });
});
