// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowRunProgressPanel } from "@/components/dashboard/workflow-run-progress-panel";
import type { WorkflowRunProgress } from "@/lib/workflow-run-progress";

const NOW = new Date("2026-09-02T00:05:00.000Z").getTime();

function progress(overrides: Partial<WorkflowRunProgress> = {}): WorkflowRunProgress {
  return {
    runId: 1,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    workflowName: "Deploy",
    status: "in_progress",
    conclusion: null,
    startedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:05:00.000Z",
    runAttempt: 1,
    estimateMs: 600_000,
    jobs: [
      {
        name: "build",
        state: "running",
        currentStep: "Build",
        startedAt: "2026-09-02T00:02:00.000Z",
        completedAt: null,
        baselineMs: null,
        htmlUrl: null,
      },
      {
        name: "deploy",
        state: "queued",
        currentStep: null,
        startedAt: null,
        completedAt: null,
        baselineMs: 130_000,
        htmlUrl: null,
      },
    ],
    ...overrides,
  };
}

function stubFetch(body: { progress: WorkflowRunProgress }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WorkflowRunProgressPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("閉じている間は取得もせず、何も出さない", () => {
    const fetchMock = stubFetch({ progress: progress() });
    const { container } = render(
      <WorkflowRunProgressPanel
        repositoryFullName="guchi-apps/issue-deck"
        runId={1}
        open={false}
        title="本番デプロイの内訳"
      />,
    );

    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("開くと、ジョブごとの状態・現在ステップ・経過時間・見込みを出す", async () => {
    stubFetch({ progress: progress() });
    render(
      <WorkflowRunProgressPanel
        repositoryFullName="guchi-apps/issue-deck"
        runId={1}
        open
        title="本番デプロイの内訳"
      />,
    );

    await waitFor(() => expect(screen.getByText("build")).toBeTruthy());
    // 「どこまで進んだか」の実体は、実行中ジョブの現在ステップ
    expect(screen.getByText("実行中: Build")).toBeTruthy();
    // 待ちのジョブには、直近の成功した実行での所要時間を目安として添える
    expect(screen.getByText("待ち（通常 2分10秒）")).toBeTruthy();
    expect(screen.getByText("5分0秒")).toBeTruthy();
    expect(screen.getByText("約10分0秒")).toBeTruthy();
    expect(screen.getByText(/残り約5分0秒/)).toBeTruthy();
  });

  it("実績が足りないときは見込みを出さず、その旨を書く", async () => {
    stubFetch({ progress: progress({ estimateMs: null }) });
    render(
      <WorkflowRunProgressPanel
        repositoryFullName="guchi-apps/issue-deck"
        runId={1}
        open
        title="本番デプロイの内訳"
      />,
    );

    await waitFor(() => expect(screen.getByText("build")).toBeTruthy());
    // 見込みの数字は出さない（残っているのは「出していません」という断りだけ）
    expect(screen.queryByText(/^見込み /)).toBeNull();
    expect(screen.queryByText(/残り約/)).toBeNull();
    expect(
      screen.getByText("成功した実行の実績が足りないため、見込みは出していません。"),
    ).toBeTruthy();
  });

  it("見込みを超えたら、残り時間ではなく超過として出す", async () => {
    stubFetch({ progress: progress({ estimateMs: 120_000 }) });
    render(
      <WorkflowRunProgressPanel
        repositoryFullName="guchi-apps/issue-deck"
        runId={1}
        open
        title="本番デプロイの内訳"
      />,
    );

    await waitFor(() => expect(screen.getByText("見込みを超過")).toBeTruthy());
    expect(screen.queryByText(/残り約/)).toBeNull();
  });
});
