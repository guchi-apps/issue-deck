// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionRecoveryButton } from "@/components/dashboard/session-recovery-button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue, IssueLabel } from "@/types/issue";

const updateIssue = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({
    updateIssue,
    isSubmitting: false,
    error: null,
  }),
}));

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
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    checkout: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1830",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1830,
    issueTitle: null,
    issueId: null,
    state: "GONE",
    exitStatus: null,
    firstSeenAt: "2026-08-17T00:00:00Z",
    lastReportedAt: "2026-08-17T00:30:00Z",
    activity: "WAITING_INPUT",
    activityAt: "2026-08-17T00:10:00Z",
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1830,
    title: "Claude Codeのセッション自動クローズ後の復旧機能を追加",
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
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1830",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function label(name: string): IssueLabel {
  return { name, color: "#000000", description: null } as IssueLabel;
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1830,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
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

function renderButton({
  issue = makeIssue(),
  session = makeSession(),
  dispatch = makeDispatch(),
}: {
  issue?: Issue;
  session?: DispatchSessionView;
  dispatch?: DispatchStateHandle;
} = {}) {
  return render(
    <SessionRecoveryButton
      issue={issue}
      session={session}
      dispatch={dispatch}
      onIssueUpdated={vi.fn()}
    />,
  );
}

function recoveryButton() {
  return screen.queryByRole("button", { name: "セッションを復旧" });
}

/**
 * #1830。回答が遅れているうちに畳まれたセッションを、終了した行のその場で呼び戻せるようにする。
 * 積むのは起動ジョブ（`LAUNCH`）そのもので、会話を引き継ぐかどうかを決めるのはサブPCの
 * ランチャー（`--continue`・#1541）。
 */
describe("SessionRecoveryButton", () => {
  beforeEach(() => {
    enqueue.mockResolvedValue(true);
    updateIssue.mockResolvedValue(makeIssue({ labels: [label("11.local")] }));
  });

  afterEach(() => {
    cleanup();
    enqueue.mockReset();
    updateIssue.mockReset();
  });

  it("動いているセッションには出さない（復旧する相手がいない）", () => {
    const { container } = renderButton({ session: makeSession({ state: "ALIVE" }) });
    expect(container.firstChild).toBeNull();
  });

  it("終了したセッションに出し、押すと同じホストへ起動ジョブを積む", async () => {
    renderButton();
    expect(recoveryButton()).not.toBeNull();
    fireEvent.click(recoveryButton()!);
    await waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1830,
        hostName: "subpc",
      });
    });
  });

  // 付け直さないと、無人実行（claude-issue-dispatch.yml）と二重に動く余地が残る
  it("積めたら11.localを付け直す", async () => {
    renderButton();
    fireEvent.click(recoveryButton()!);
    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        number: 1830,
        labels: ["11.local"],
      });
    });
  });

  it("積めなければラベルは付けない（拒否されたのにラベルだけ残さない）", async () => {
    enqueue.mockResolvedValue(false);
    renderButton();
    fireEvent.click(recoveryButton()!);
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("押すと何が起きるかを常に添える", () => {
    renderButton();
    expect(screen.getByText(/前回の会話の続きから再開します/)).not.toBeNull();
  });

  // #1332の「停止」と同じ立場。導線ごと消すと、なぜ復旧できないのかが画面から分からない
  it("サブPCが申告していなければ、ボタンは残して理由を出す", () => {
    renderButton({ dispatch: makeDispatch({ hosts: [] }) });
    expect(recoveryButton()).not.toBeNull();
    expect(recoveryButton()!.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/申告がまだ届いていません/)).not.toBeNull();
  });

  it("同じIssueで既にセッションが動いていれば押せない", () => {
    const alive = makeSession({ state: "ALIVE", tmuxSessionName: "issue-deck-issue-1830" });
    renderButton({ dispatch: makeDispatch({ sessions: [alive] }) });
    expect(recoveryButton()!.hasAttribute("disabled")).toBe(true);
  });

  it("closedなIssueには出さない", () => {
    const { container } = renderButton({ issue: makeIssue({ state: "closed" }) });
    expect(container.firstChild).toBeNull();
  });

  it("手作業Issue（71.manual-step）には出さない", () => {
    const { container } = renderButton({
      issue: makeIssue({ labels: [label("71.manual-step")] }),
    });
    expect(container.firstChild).toBeNull();
  });

  /**
   * 横断質問セッション（#1454）は畳むと会話を引き継げない（cwdが質問Issue間で共有されるため
   * `--continue`が別の質問を拾う。#1648）。呼び戻す導線を出すと、続きどころか別の質問の続きが
   * 始まる。
   */
  it("横断質問から立ったセッションには出さない", () => {
    const { container } = renderButton({
      dispatch: makeDispatch({
        jobs: [makeJob({ kind: "CROSS_REPO_QUESTION", status: "SUCCEEDED" })],
      }),
    });
    expect(container.firstChild).toBeNull();
  });
});
