// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import type { ReleaseStatus } from "@/hooks/use-release-status";
import type { ConnectedRepository } from "@/types/repository";

const preparationState = vi.hoisted(() => ({ prepState: "idle" as string }));
vi.mock("@/hooks/use-release-preparation", () => ({
  useReleasePreparation: () => ({ failure: null, prepState: preparationState.prepState, reload: async () => {} }),
}));

const modeState = vi.hoisted(() => ({ mode: { mode: "legacy", label: "未対応" } as { mode: string; label: string } | null }));
vi.mock("@/hooks/use-release-start-mode", () => ({ useReleaseStartMode: () => modeState.mode }));

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
    preparationState.prepState = "idle";
    modeState.mode = { mode: "legacy", label: "未対応" };
  });

  it("準備状態の取得前（unknown）は起動ボタンを無効にし、確認も開けない（#4556）", () => {
    preparationState.prepState = "unknown";
    const triggerRelease = vi.fn(async () => true);
    render(
      <MobileReleaseSheet
        {...baseProps}
        triggerRelease={triggerRelease}
        repository={makeRepository("guchi-apps/issue-deck")}
        releaseStatus={makeStatus()}
      />,
    );
    const button = screen.getByRole("button", { name: "準備状態を確認中" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("button", { name: "起動する" })).toBeNull();
    expect(triggerRelease).not.toHaveBeenCalled();
  });

  it("開始方式の取得中は確認を開けず、取得後は候補作成の説明になる", () => {
    modeState.mode = null;
    const props = { ...baseProps, repository: makeRepository("guchi-apps/issue-deck"), releaseStatus: makeStatus() };
    const { rerender } = render(<MobileReleaseSheet {...props} />);
    const button = screen.getByRole("button", { name: "開始方式を確認中" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("button", { name: "起動する" })).toBeNull();
    modeState.mode = { mode: "candidate", label: "候補" };
    rerender(<MobileReleaseSheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "候補を作成して検証" }));
    expect(screen.getByText("リリース候補を作成して検証しますか？")).toBeTruthy();
  });

  it("aide-iosではMacの手順を出し、リリース開始ボタンは出さない", () => {
    render(
      <MobileReleaseSheet
        {...baseProps}
        repository={makeRepository("guchi-apps/aide-ios")}
        releaseStatus={makeStatus({ phase: "release_pending", developVersion: "1.1.0" })}
      />,
    );

    expect(screen.getByText("AIDE-iosを実機へ反映する手順")).not.toBeNull();
    expect(screen.queryByText("候補を作成して検証")).toBeNull();
  });

  it("myroomではWeb/iOS本体の2種類の手順を出し、リリース開始ボタンは通常どおり出す", () => {
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
    expect(screen.getByText("候補を作成して検証")).not.toBeNull();
  });

  it("iOSアプリを持たないリポジトリでは、どちらの案内も出さない（完了条件）", () => {
    render(
      <MobileReleaseSheet
        {...baseProps}
        repository={makeRepository("guchi-apps/vps")}
        releaseStatus={makeStatus()}
      />,
    );

    expect(screen.queryByText("AIDE-iosを実機へ反映する手順")).toBeNull();
    expect(screen.queryByText(/Webだけ更新/)).toBeNull();
    expect(screen.getByText("候補を作成して検証")).not.toBeNull();
  });

  it("本番デプロイ失敗中は確認チェックを付けたときだけ手動上書きを渡す", () => {
    const triggerRelease = vi.fn(async () => true);
    render(
      <MobileReleaseSheet
        {...baseProps}
        triggerRelease={triggerRelease}
        repository={makeRepository("guchi-apps/issue-deck")}
        releaseStatus={makeStatus({
          deployWorkflowRun: {
            status: "completed",
            conclusion: "failure",
            htmlUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
            createdAt: "2026-10-03T00:00:00Z",
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "修正リリース" }));
    const action = screen.getByRole("button", { name: "起動する" });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    expect(triggerRelease).toHaveBeenCalledWith(undefined, true);
  });
});
