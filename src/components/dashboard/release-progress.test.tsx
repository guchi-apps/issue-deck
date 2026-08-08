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
    ...overrides,
  };
}

function statusWithReleaseCi(ciState: CiState | null): AvailableReleaseStatus {
  return makeStatus({
    phase: "release_pr_open",
    releasePullRequest: { number: 42, url: "https://example.com/pr/42", title: "release", ciState },
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
            version: "1.1.0",
            reason: null,
          },
        })}
      />,
    );
    expect(screen.getByText("CI失敗")).not.toBeNull();
  });
});
