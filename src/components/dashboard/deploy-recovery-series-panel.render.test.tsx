// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeployRecoverySeriesPanel } from "@/components/dashboard/deploy-recovery-series-panel";
import type { DeployRecoverySeriesView } from "@/lib/deploy-recovery-series-run";

const base: DeployRecoverySeriesView = {
  id: "s1",
  repositoryFullName: "guchi-apps/issue-deck",
  status: "releasing",
  statusLabel: "本番反映中",
  stageIndex: 3,
  stageLabel: "本番へ反映中",
  active: true,
  failedRunId: 100,
  failedRunAttempt: 1,
  failedRunUrl: "https://example.test/runs/100",
  failedSha: "abc",
  scope: "fix_until_main",
  recoveryPullRequestNumber: 9,
  expiresAt: "2026-10-13T00:00:00Z",
  issueNumber: 55,
  pullRequestNumber: 12,
  cause: "code",
  repairRoundsUsed: 1,
  stopReason: null,
  stopMessage: null,
  releaseSha: "sha1",
  releaseRunUrl: null,
  releaseAttempts: 0,
  recoveredAt: null,
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
};

function mockSeries(series: Partial<DeployRecoverySeriesView>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ series: { ...base, ...series } }), { status: 200 })));
}

describe("DeployRecoverySeriesPanel（#4451）", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => cleanup());

  it("本番反映中は6段階のうち4つ目を現在位置にし、停止を押せる", async () => {
    mockSeries({});
    render(<DeployRecoverySeriesPanel repositoryFullName="guchi-apps/issue-deck" runId={100} />);
    await waitFor(() => expect(screen.getByText("操作は不要です。", { exact: false })).toBeTruthy());
    const current = screen.getByText("本番へ反映中", { selector: "li" });
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByRole("listitem").filter((item) => item.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  });

  it("要対応のときは理由と操作が必要なことを出す", async () => {
    mockSeries({ status: "needs_attention", statusLabel: "要対応", stageIndex: -1, active: false, stopReason: "release_stalled", stopMessage: "同じ内容のデプロイ失敗が続いたため止めました。" });
    render(<DeployRecoverySeriesPanel repositoryFullName="guchi-apps/issue-deck" runId={100} />);
    await waitFor(() => expect(screen.getByText("操作が必要です。", { exact: false })).toBeTruthy());
    expect(screen.getByText("同じ内容のデプロイ失敗が続いたため止めました。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("稼働SHAを確かめられた完了だけを完了と表示する", async () => {
    mockSeries({ status: "recovered", statusLabel: "復旧済み", stageIndex: 5, stageLabel: "完了", active: false, recoveredAt: "2026-10-12T01:00:00Z" });
    render(<DeployRecoverySeriesPanel repositoryFullName="guchi-apps/issue-deck" runId={100} />);
    await waitFor(() => expect(screen.getByText("完了しました。", { exact: false })).toBeTruthy());
  });
});
