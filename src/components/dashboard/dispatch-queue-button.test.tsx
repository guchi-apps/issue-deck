// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchQueueButton } from "@/components/dashboard/dispatch-queue-button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const dismiss = vi.fn();
const cancel = vi.fn();
const prioritize = vi.fn();

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
    queuePriority: 0,
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
    prioritize,
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
  prioritize.mockResolvedValue(true);
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

/**
 * #1541。夜にまとめて積んだあと「これを次に流したい」が出てくるが、キューは積んだ順で
 * 固定されていて、取り消して積み直すと最後尾へ回るだけだった。
 */
describe("DispatchQueueButton の先頭へ上げる", () => {
  function queued(id: string, issueNumber: number, overrides: Partial<DispatchJobView> = {}) {
    return makeJob({ id, issueNumber, status: "QUEUED", finishedAt: null, ...overrides });
  }

  // 共通の`openQueue`は「直近の失敗」の描画を待つが、順番待ちだけのキューにはその節が出ない
  async function openQueued(jobs: DispatchJobView[]) {
    render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
    fireEvent.click(screen.getByLabelText("実行キュー"));
    await waitFor(() => expect(screen.getByText("順番待ち")).toBeDefined());
  }

  it("2行目以降の↑はprioritizeを呼ぶ", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z" }),
    ]);

    fireEvent.click(screen.getByLabelText("#1602のジョブを先頭へ上げる"));

    expect(prioritize).toHaveBeenCalledWith("job-2");
    // 取り消し・表示消しとは別の操作。同じ行に並ぶので取り違えないことを確かめる
    expect(cancel).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  // 押しても何も変わらない
  it("先頭の行には↑を出さない", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z" }),
    ]);

    expect(screen.queryByLabelText("#1601のジョブを先頭へ上げる")).toBeNull();
  });

  // 画面の並びは払い出し（claimDispatchJob）と同じでなければならない
  it("先頭へ上げたジョブが1番に出て、その行には↑が出ない", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z", queuePriority: 1 }),
    ]);

    expect(screen.queryByLabelText("#1602のジョブを先頭へ上げる")).toBeNull();
    expect(screen.getByLabelText("#1601のジョブを先頭へ上げる")).toBeDefined();
  });

  // 終わったジョブの順番を入れ替えても意味が無い
  it("実行中・直近の失敗には↑を出さない", async () => {
    await openQueue([
      makeJob({ id: "job-1", issueNumber: 1603, status: "RUNNING", finishedAt: null }),
      makeJob({ id: "job-2", issueNumber: 1604 }),
    ]);

    expect(screen.queryByLabelText("#1603のジョブを先頭へ上げる")).toBeNull();
    expect(screen.queryByLabelText("#1604のジョブを先頭へ上げる")).toBeNull();
  });
});
