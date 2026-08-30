// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanReviewButton } from "@/components/dashboard/plan-review-button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { Issue } from "@/types/issue";

const enqueue = vi.fn();

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-17T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: true,
    codeReviewCapable: true,
    codexCapable: null,
    codexRemoteControlCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1855,
    title: "ローカルセッションが出した計画にも計画の関門（G1）を自動で通す",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1855",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1855,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "PLAN_REVIEW",
    status: "QUEUED",
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
    createdAt: "2026-08-17T00:00:00Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs: [] as DispatchJobView[],
    sessions: [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue,
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  } as DispatchStateHandle;
}

function reviewButton() {
  return screen.getByRole("button", { name: "計画をレビュー" });
}

/**
 * #1855。主経路は計画コメントの投稿を契機とした自動起動で、このボタンはその取りこぼし
 * （サブPCが落ちていた・計画を直した・ラベルを後から付けた）を人が拾うための入口。
 */
describe("PlanReviewButton", () => {
  beforeEach(() => {
    enqueue.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("押すと計画レビューのジョブを積む", async () => {
    render(<PlanReviewButton issue={makeIssue()} dispatch={makeDispatch()} />);

    fireEvent.click(reviewButton());

    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1855,
        hostName: "subpc",
        kind: "plan_review",
      });
    });
  });

  // **押せない理由は押す前に出し、ボタンごと消さない**（#1180・#1332と同じ立場）
  it("pollerが計画レビューに対応していなければ、理由を出して押せなくする", () => {
    render(
      <PlanReviewButton
        issue={makeIssue()}
        dispatch={makeDispatch({ hosts: [makeHost({ planReviewCapable: null })] })}
      />,
    );

    expect((reviewButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/計画レビューに対応していません/)).toBeTruthy();
  });

  it("そのホストで実行できないリポジトリでは理由を出して押せなくする", () => {
    render(
      <PlanReviewButton
        issue={makeIssue({ repositoryFullName: "guchi-apps/car-care" })}
        dispatch={makeDispatch()}
      />,
    );

    expect((reviewButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/実行できません/)).toBeTruthy();
  });

  // pull型で最大1分ほど何も起きないので、積んだ後の状態を出す（#1332と同じ理由）
  it("積んだ後はジョブの状態を出す", () => {
    render(
      <PlanReviewButton issue={makeIssue()} dispatch={makeDispatch({ jobs: [makeJob()] })} />,
    );

    expect(screen.getByText(/順番待ち/)).toBeTruthy();
    expect((reviewButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
