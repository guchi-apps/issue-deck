// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchQueueButton } from "@/components/dashboard/dispatch-queue-button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const dismiss = vi.fn();
const cancel = vi.fn();

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1479,
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "FAILED",
    message: "tmuxの起動に失敗しました。",
    instruction: null,
    tmuxSessionName: null,
    createdAt: NOW.toISOString(),
    claimedAt: null,
    startedAt: null,
    finishedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeDispatch(jobs: DispatchJobView[]): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs,
    sessions: [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel,
    dismiss,
  } as unknown as DispatchStateHandle;
}

async function openQueue(jobs: DispatchJobView[]) {
  render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
  fireEvent.click(screen.getByLabelText("実行キュー"));
  await waitFor(() => expect(screen.getByText("直近の失敗")).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  dismiss.mockResolvedValue(true);
  cancel.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

/**
 * #1479。終了したジョブは24時間出続けるため、対処が済んだ失敗を畳めないと新しい失敗が
 * 古いものに埋もれる。
 */
describe("DispatchQueueButton の失敗の表示を消す", () => {
  it("失敗の行の×はdismissを呼ぶ", async () => {
    await openQueue([makeJob()]);

    fireEvent.click(screen.getByLabelText("#1479の失敗の表示を消す"));

    expect(dismiss).toHaveBeenCalledWith("job-1");
    // 取り消し（走る前のジョブを止める操作）とは別物。取り違えると実行中のものを消せてしまう
    expect(cancel).not.toHaveBeenCalled();
  });

  // 実行中・順番待ちの×は従来どおり取り消しのまま
  it("順番待ちの×はcancelを呼ぶ", async () => {
    await openQueue([
      makeJob(),
      makeJob({ id: "job-2", issueNumber: 1480, status: "QUEUED", finishedAt: null }),
    ]);

    fireEvent.click(screen.getByLabelText("#1480のジョブを取り消す"));

    expect(cancel).toHaveBeenCalledWith("job-2");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("失敗が1件だけならまとめて消すボタンは出さない（行の×で足りる）", async () => {
    await openQueue([makeJob()]);

    expect(screen.queryByText(/失敗の表示をすべて消す/)).toBeNull();
  });

  it("失敗が2件以上ならまとめて消せる", async () => {
    await openQueue([makeJob(), makeJob({ id: "job-2", issueNumber: 1480 })]);

    fireEvent.click(screen.getByText(/失敗の表示をすべて消す（2件）/));

    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2));
    expect(dismiss).toHaveBeenCalledWith("job-1");
    expect(dismiss).toHaveBeenCalledWith("job-2");
  });
});
