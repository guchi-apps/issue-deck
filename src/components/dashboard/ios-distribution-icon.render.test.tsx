// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IosDistributingBadge,
  IosDistributionIcon,
  useIosDistributionState,
} from "@/components/dashboard/ios-distribution-icon";

const SHA = "abcdef1234567890";

function stub(runStatus: "in_progress" | "completed") {
  const body = {
    available: true,
    latestDeliveredBuild: null,
    release: { sha: SHA, merged: true, isMainTip: true, webDeploy: "success", deliveredBuild: null },
    runs: [
      {
        id: 1,
        htmlUrl: "https://github.com/o/r/actions/runs/1",
        headSha: SHA,
        headBranch: "main",
        event: "workflow_dispatch",
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:01:00Z",
        status: runStatus,
        conclusion: runStatus === "completed" ? "failure" : null,
        verdict: runStatus === "completed" ? { kind: "failed", failedStage: null } : { kind: "running" },
        stages: [],
        notes: [],
      },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const state = useIosDistributionState("o", "r", 5, enabled);
  return (
    <div>
      <IosDistributionIcon pending={state.pending} />
      {state.running && <IosDistributingBadge />}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("iOS配布中バッジ（#3806）", () => {
  it("配布のworkflowが実行中ならバッジを出す", async () => {
    stub("in_progress");
    render(<Probe />);
    expect(await screen.findByText("iOS配布中")).toBeTruthy();
  });

  it("実行中でなければバッジを出さない（失敗は斜線アイコンだけ）", async () => {
    stub("completed");
    render(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("iOS未配布")).toBeTruthy());
    expect(screen.queryByText("iOS配布中")).toBeNull();
  });

  it("enabledがfalseなら取得しない", () => {
    stub("in_progress");
    render(<Probe enabled={false} />);
    expect(fetch).not.toHaveBeenCalled();
  });
});
