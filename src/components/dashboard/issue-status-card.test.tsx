// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueStatusCard } from "@/components/dashboard/issue-status-card";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { IssueExecutionTarget } from "@/lib/dispatch/issue-execution-target";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";
import type { Issue } from "@/types/issue";

const NOW = "2026-08-15T12:00:00.000Z";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1577,
    title: "Issue詳細画面のデザイン見直し",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1577",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [],
    jobs: [] as DispatchJobView[],
    sessions: [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  } as DispatchStateHandle;
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1577",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1577,
    state: "ALIVE",
    exitStatus: null,
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    firstSeenAt: NOW,
    lastReportedAt: NOW,
    ...overrides,
  } as DispatchSessionView;
}

const EXECUTION_TARGET: IssueExecutionTarget = {
  kind: "actions",
  expectsActionsRun: true,
  host: null,
} as IssueExecutionTarget;

function renderCard(props: Partial<Parameters<typeof IssueStatusCard>[0]> = {}) {
  return render(
    <IssueStatusCard
      issue={makeIssue()}
      dispatch={makeDispatch()}
      dispatchJob={null}
      issueSession={null}
      executionTarget={EXECUTION_TARGET}
      workflowRun={null}
      workflowRunId={null}
      qaAnswerPending={false}
      {...props}
    />,
  );
}

describe("IssueStatusCard", () => {
  afterEach(() => {
    cleanup();
  });

  /** #1577。走っているものが何も無いIssueで空のカードが場所を取ると、集約した意味が無くなる */
  it("進捗も実行中のものも無ければ何も描かない", () => {
    const { container } = renderCard();
    expect(container.textContent).toBe("");
  });

  it("Project Statusがあれば進捗ステップを出す", () => {
    renderCard({ issue: makeIssue({ projectStatus: "Implementation" }) });
    expect(screen.getByRole("list", { name: "実装状況" })).not.toBeNull();
  });

  it("Statusが無くてもセッションが走っていればカードを出す", () => {
    renderCard({ issueSession: makeSession() });
    expect(screen.queryByRole("list", { name: "実装状況" })).toBeNull();
    expect(screen.getByText(/実行中/)).not.toBeNull();
  });

  it("Claudeの回答待ちを同じカードの中に出す", () => {
    renderCard({ qaAnswerPending: true });
    expect(screen.getByText("Claudeの回答待ち")).not.toBeNull();
  });

  /** #1663。開いた直後に「次にどこの何を押すか」が分かるようにする */
  it("確認待ちの案内があれば、進捗ステップの下に出す", () => {
    renderCard({
      issue: makeIssue({ projectStatus: "Implementation" }),
      checkUserGuidance: resolveCheckUserGuidance({ reason: "plan", placement: "status" }),
    });
    expect(screen.getByText("計画の承認が必要です")).not.toBeNull();
    expect(screen.getByRole("button", { name: "承認欄へ移動" })).not.toBeNull();
  });

  it("進捗が無くても、確認待ちの案内があればカードを出す", () => {
    renderCard({
      checkUserGuidance: resolveCheckUserGuidance({ reason: "merge", placement: "status" }),
    });
    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();
  });

  /**
   * #1676。起動が成功していてセッションも立っていれば、2つは同じ「サブPCで動いている」ことを
   * 2行で言っているだけになる。**起動が終わっていないあいだは畳まない**（順番待ちの理由・
   * 失敗理由・取り消しは`DispatchJobStatus`にしか無い）。
   */
  describe("起動ジョブの行を畳む（#1676）", () => {
    function makeLaunchJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
      return {
        id: "job-launch",
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1577,
        issueTitle: null,
        issueId: null,
        targetHost: "subpc",
        kind: "LAUNCH",
        status: "SUCCEEDED",
        queuePriority: 0,
        message: null,
        instruction: null,
        tmuxSessionName: "issue-deck-issue-1577",
        createdAt: NOW,
        claimedAt: null,
        startedAt: null,
        finishedAt: NOW,
        ...overrides,
      };
    }

    it("起動が成功してセッションが立っていれば、起動の行は出さない", () => {
      renderCard({ dispatchJob: makeLaunchJob(), issueSession: makeSession() });

      expect(screen.queryByText(/サブPCで起動しました/)).toBeNull();
      expect(screen.getByText(/サブPC・実行中/)).not.toBeNull();
    });

    it("順番待ちのあいだは起動の行をそのまま出す", () => {
      renderCard({
        dispatchJob: makeLaunchJob({ status: "QUEUED", finishedAt: null }),
        issueSession: makeSession(),
      });

      expect(screen.getByText(/サブPCで順番待ち/)).not.toBeNull();
    });
  });
});
