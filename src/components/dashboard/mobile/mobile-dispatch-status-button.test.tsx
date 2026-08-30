// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// シートの中身はIssue詳細への遷移（#1625）にルーターを要求する。jsdomではApp Routerが
// マウントされていないため、遷移だけ差し替える
const openIssue = vi.fn();
vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue, openPullRequest: vi.fn() }),
}));

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 1,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1638,
    issueTitle: "スマホ画面のレイアウト改善",
    issueId: "issue-1638",
    targetHost: "subpc",
    agent: "claude",
    kind: "LAUNCH",
    status: "RUNNING",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const refresh = vi.fn();

function makeDispatch(overrides: {
  hosts?: DispatchHostView[];
  jobs?: DispatchJobView[];
  sessions?: DispatchSessionView[];
  /** 更新インジケーター（#1773）。既定は「12秒前に取得できていて、いまは取得していない」 */
  fetchedAt?: number | null;
  isFetching?: boolean;
}): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [],
    jobs: overrides.jobs ?? [],
    sessions: overrides.sessions ?? [],
    concurrency: 2,
    fetchedAt: overrides.fetchedAt ?? Date.now() - 12_000,
    isFetching: overrides.isFetching ?? false,
    pollIntervalMs: 20_000,
    refresh,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    prioritize: vi.fn(),
  } as unknown as DispatchStateHandle;
}

afterEach(() => {
  cleanup();
});

describe("MobileDispatchStatusButton（#1638）", () => {
  it("申告しているホストが無ければ何も出さない", () => {
    const { container } = render(
      <MobileDispatchStatusButton dispatch={makeDispatch({ hosts: [] })} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("実行中の件数をバッジに出す", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    expect(screen.getByRole("button", { name: "実行状況" })).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("押すとシートに実行キューの中身が出る", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "実行状況" }));

    expect(screen.getByText("実行状況")).toBeTruthy();
    expect(screen.getByText("実行中")).toBeTruthy();
    expect(screen.getByText(/#1638/)).toBeTruthy();
    // このキューが何を映しているかの但し書き（#1567）
    expect(screen.getByText(/GitHub Actionsでの無人実行はここには出ません/)).toBeTruthy();
  });

  /**
   * #1773。更新インジケーターはPCの実行キューと共有の中身（`DispatchQueueContent`）に
   * 置いてあるので、シート側にも同じものが出る。外出先で見るぶん、出ている内容が
   * いつ時点かはむしろこちらで要る。
   */
  it("シートにも更新インジケーターが出て、押すと取り直す", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "実行状況" }));
    expect(screen.getByText("12秒前に更新・20秒間隔")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("実行キューを今すぐ更新"));
    expect(refresh).toHaveBeenCalled();
  });

  // 行のタイトルからIssue詳細を開く（#1625）。PCの実行キューと同じ振る舞いにする
  it("行のタイトルを押すとIssue詳細へ遷移し、シートを閉じる", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "実行状況" }));
    fireEvent.click(
      screen.getByRole("button", { name: "#1638 スマホ画面のレイアウト改善をissue-deckで開く" }),
    );

    expect(openIssue).toHaveBeenCalledWith("issue-1638");
    expect(screen.queryByText(/GitHub Actionsでの無人実行はここには出ません/)).toBeNull();
  });
});
