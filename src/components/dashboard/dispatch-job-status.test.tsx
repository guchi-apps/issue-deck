// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1468,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "SUCCEEDED",
    message: null,
    instruction: null,
    command: null,
    manualStepLine: null,
    exitCode: null,
    commandOutput: null,
    tmuxSessionName: "issue-deck-issue-1468",
    queuePriority: 0,
    createdAt: new Date(2026, 7, 15, 9, 0, 0).toISOString(),
    claimedAt: null,
    startedAt: null,
    finishedAt: new Date(2026, 7, 15, 9, 5, 0).toISOString(),
    ...overrides,
  };
}

function renderStatus(job: DispatchJobView = makeJob()) {
  return render(<DispatchJobStatus job={job} onCancel={vi.fn()} isSubmitting={false} />);
}

describe("DispatchJobStatus", () => {
  afterEach(cleanup);

  // #1468。「3時間前」では手元で動いているtmuxセッションと突き合わせられない
  it("時刻は相対表現ではなく月日と時分で出す", () => {
    renderStatus();

    expect(screen.getByText("8月15日 09:05")).not.toBeNull();
    expect(screen.queryByText(/時間前/)).toBeNull();
  });

  // #1468。読むためではなくコピーするための文字列なので、行としては置かない
  it("tmux attachのコマンドを行として出さない", () => {
    renderStatus();

    expect(screen.queryByText(/tmux attach/)).toBeNull();
  });

  it("状態のピルを押すとtmux attachのコマンドをコピーする", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderStatus();

    fireEvent.click(screen.getByRole("button", { name: /サブPCで起動しました/ }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("tmux attach -t issue-deck-issue-1468"),
    );
    await waitFor(() => expect(screen.getByText("コピーしました")).not.toBeNull());
  });

  // 起動できていないジョブにはattach先が無い。押しても何も起きないものをボタンにしない
  it("セッション名が無ければ押せる表示にしない", () => {
    renderStatus(makeJob({ status: "QUEUED", tmuxSessionName: null, finishedAt: null }));

    expect(screen.queryByRole("button", { name: /サブPCで/ })).toBeNull();
  });

  it("失敗の理由は本文として出す（スマホではホバーできない）", () => {
    renderStatus(makeJob({ status: "FAILED", message: "start-issue.sh が見つかりません" }));

    expect(screen.getByText("start-issue.sh が見つかりません")).not.toBeNull();
  });
});
