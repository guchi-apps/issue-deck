// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import type { ReleaseStatus } from "@/hooks/use-release-status";
import type { ConnectedRepository } from "@/types/repository";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

function makeStatus(overrides: Partial<AvailableReleaseStatus> = {}): AvailableReleaseStatus {
  return {
    available: true,
    mainVersion: "1.0.0",
    developVersion: "1.0.0",
    phase: "none",
    workflowRun: null,
    deployWorkflowRun: null,
    bumpPullRequest: null,
    releasePullRequest: null,
    otherPullRequests: [],
    ...overrides,
  };
}

function makeRepository(fullName: string): ConnectedRepository {
  return {
    id: fullName,
    name: fullName.split("/")[1]!,
    fullName,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    excludedFromIssueCreation: false,
    releaseCheckSince: null,
  };
}

const baseProps = {
  open: true,
  onOpenChange: () => {},
  issues: [],
  releaseStatusLoading: false,
  releaseStatusError: null,
  triggerRelease: vi.fn(async () => true),
  isTriggeringRelease: false,
};

describe("MobileReleaseSheet iOSへの反映欄（#3579）", () => {
  afterEach(() => {
    cleanup();
  });

  it("aide-iosではMacの手順を出し、リリースworkflow起動ボタンは出さない", () => {
    render(
      <MobileReleaseSheet
        {...baseProps}
        repository={makeRepository("guchi-apps/aide-ios")}
        releaseStatus={makeStatus({ phase: "release_pending", developVersion: "1.1.0" })}
      />,
    );

    expect(screen.getByText("AIDE-iosを実機へ反映する手順")).not.toBeNull();
    expect(screen.queryByText("リリースworkflowを起動")).toBeNull();
  });

  it("myroomではWeb/iOS本体の2種類の手順を出し、リリースworkflow起動ボタンは通常どおり出す", () => {
    render(
      <MobileReleaseSheet
        {...baseProps}
        repository={makeRepository("guchi-apps/myroom")}
        releaseStatus={makeStatus()}
      />,
    );

    expect(screen.getByText("Webだけ更新（frontend・backendの変更）")).not.toBeNull();
    expect(
      screen.getByText("アプリ本体の入れ直し（ios/・アプリアイコンの変更）"),
    ).not.toBeNull();
    expect(screen.getByText("リリースworkflowを起動")).not.toBeNull();
  });

  it("iOSアプリを持たないリポジトリでは、どちらの案内も出さない（完了条件）", () => {
    render(
      <MobileReleaseSheet
        {...baseProps}
        repository={makeRepository("guchi-apps/issue-deck")}
        releaseStatus={makeStatus()}
      />,
    );

    expect(screen.queryByText("AIDE-iosを実機へ反映する手順")).toBeNull();
    expect(screen.queryByText(/Webだけ更新/)).toBeNull();
    expect(screen.getByText("リリースworkflowを起動")).not.toBeNull();
  });
});
